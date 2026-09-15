<?php

namespace App\Console\Commands;

use App\Data\CanonicalMessage;
use App\Jobs\ProcessInboundMessage;
use App\Models\FailedWebhookEvent;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;
use PhpAmqpLib\Connection\AMQPStreamConnection;
use PhpAmqpLib\Exception\AMQPConnectionClosedException;
use PhpAmqpLib\Exception\AMQPTimeoutException;
use PhpAmqpLib\Message\AMQPMessage;
use Throwable;

/**
 * Consumer manual RabbitMQ menggunakan php-amqplib.
 *
 * Digunakan sebagai pengganti Laravel Queue karena vladimir-yuldashev/laravel-queue-rabbitmq
 * tidak support Laravel 13. Jalankan satu worker per queue type:
 *
 *   php artisan rabbitmq:consume inbound.whatsapp
 *   php artisan rabbitmq:consume inbound.line
 *   php artisan rabbitmq:consume inbound.email
 *   php artisan rabbitmq:consume inbound.telegram
 *
 * Graceful shutdown: kirim SIGTERM atau SIGINT untuk berhenti setelah pesan saat ini selesai.
 */
class ConsumeRabbitMQ extends Command
{
    protected $signature = 'rabbitmq:consume
                            {queue : Nama queue, contoh: inbound.whatsapp}
                            {--prefetch=10 : Jumlah pesan yang di-prefetch dari broker}
                            {--tries=3 : Jumlah maksimum percobaan per pesan}';

    protected $description = 'Consume dan proses pesan dari queue RabbitMQ secara manual';

    private bool $shouldStop = false;

    /** Backoff dalam detik — index = (attempt - 1) */
    private const BACKOFF = [5, 30, 60];

    public function handle(): int
    {
        $queueName = $this->argument('queue');
        $prefetch  = (int) $this->option('prefetch');
        $maxTries  = (int) $this->option('tries');

        $this->registerSignalHandlers();

        $this->info("[rabbitmq:consume] Listening on queue: {$queueName} (prefetch={$prefetch}, tries={$maxTries})");
        Log::info('RabbitMQ consumer started', ['queue' => $queueName]);

        try {
            [$connection, $channel] = $this->connect($prefetch);
        } catch (Throwable $e) {
            $this->error('Failed to connect to RabbitMQ: ' . $e->getMessage());
            return Command::FAILURE;
        }

        try {
            // Pastikan topology sudah ada — deklarasi idempoten (passive=false, durable=true)
            $this->declareTopology($channel);

            $channel->basic_consume(
                queue:       $queueName,
                consumer_tag: '',
                no_local:    false,
                no_ack:      false,
                exclusive:   false,
                nowait:      false,
                callback:    fn(AMQPMessage $msg) => $this->dispatch($msg, $maxTries),
            );

            while ($channel->is_consuming() && !$this->shouldStop) {
                try {
                    $channel->wait(null, false, 10); // 10s timeout → loop kembali
                } catch (AMQPTimeoutException) {
                    // Timeout normal — cek signal lagi
                }

                if (extension_loaded('pcntl')) {
                    pcntl_signal_dispatch();
                }
            }

        } catch (AMQPConnectionClosedException $e) {
            Log::error('RabbitMQ connection lost', ['queue' => $queueName, 'error' => $e->getMessage()]);
            $this->error('Connection lost: ' . $e->getMessage());
            return Command::FAILURE;
        } finally {
            try {
                $channel->close();
                $connection->close();
            } catch (Throwable) {
                // Abaikan error saat shutdown
            }
        }

        $this->info('[rabbitmq:consume] Stopped gracefully.');
        Log::info('RabbitMQ consumer stopped', ['queue' => $queueName]);

        return Command::SUCCESS;
    }

    // ── Private: message lifecycle ────────────────────────────────────────────

    /**
     * Entry point per-message dari basicConsume callback.
     * Tangani ack/nack dan retry logic di sini, bukan di dalam job.
     */
    private function dispatch(AMQPMessage $amqpMsg, int $maxTries): void
    {
        $payload     = null;
        $message     = null;
        $lastException = null;

        try {
            $payload = json_decode($amqpMsg->getBody(), true, 512, JSON_THROW_ON_ERROR);
            $message = CanonicalMessage::fromArray($payload);
        } catch (Throwable $e) {
            // Pesan tidak bisa di-parse — tidak bisa di-retry, buang ke DLX
            Log::error('Cannot deserialize RabbitMQ message', [
                'error'        => $e->getMessage(),
                'body_preview' => mb_substr($amqpMsg->getBody(), 0, 200),
            ]);

            $this->recordUnparseable($payload, $e);
            $this->nack($amqpMsg, requeue: false);
            return;
        }

        $job = new ProcessInboundMessage($message);

        for ($attempt = 1; $attempt <= $maxTries; $attempt++) {
            try {
                // Panggil handle() langsung — container akan inject dependencies
                app()->call([$job, 'handle']);

                $this->ack($amqpMsg);
                return; // Sukses — keluar dari loop

            } catch (Throwable $e) {
                $lastException = $e;

                Log::warning('ProcessInboundMessage attempt failed', [
                    'attempt'      => $attempt,
                    'max_tries'    => $maxTries,
                    'event_id'     => $message->event_id,
                    'company_id'   => $message->company_id,
                    'channel_type' => $message->channel_type,
                    'error'        => $e->getMessage(),
                ]);

                if ($attempt < $maxTries) {
                    $delay = self::BACKOFF[$attempt - 1] ?? 60;
                    $this->warn("  Retry {$attempt}/{$maxTries} — waiting {$delay}s...");
                    sleep($delay);
                }
            }
        }

        // Semua retry habis — panggil failed() untuk catat ke failed_webhook_events
        $job->failed($lastException);
        $this->nack($amqpMsg, requeue: false); // false = jangan requeue → ke DLX
    }

    // ── Private: connection ───────────────────────────────────────────────────

    private function connect(int $prefetch): array
    {
        $connection = new AMQPStreamConnection(
            host:     config('rabbitmq.host'),
            port:     config('rabbitmq.port'),
            user:     config('rabbitmq.user'),
            password: config('rabbitmq.password'),
            vhost:    config('rabbitmq.vhost'),
            insist:   false,
            login_method: 'AMQPLAIN',
            login_response: null,
            locale: 'en_US',
            connection_timeout: 10.0,
            read_write_timeout: 30.0,
            heartbeat: 60,
        );

        $channel = $connection->channel();
        $channel->basic_qos(null, $prefetch, false); // prefetch per consumer

        return [$connection, $channel];
    }

    /**
     * Deklarasi topology — harus identik dengan Phase 2 gateway (amqpClient.js).
     * Deklarasi bersifat idempoten: aman dijalankan meski sudah ada.
     */
    private function declareTopology($channel): void
    {
        $channel->exchange_declare('messages',     'topic',  false, true, false);
        $channel->exchange_declare('messages.dlx', 'direct', false, true, false);
        $channel->exchange_declare('message.status', 'topic', false, true, false);

        $channel->queue_declare('dead.letters', false, true, false, false);

        foreach (config('rabbitmq.queues') as $type => $queueName) {
            // Arguments must match amqpClient.js byte for byte. They did not:
            // the gateway sets x-dead-letter-routing-key to "dead.{type}" while
            // this declared plain "dead", so RabbitMQ rejected the redeclare
            // with PRECONDITION_FAILED and the consumer could never start —
            // inbound has never actually run end to end.
            $channel->queue_declare(
                queue:      $queueName,
                passive:    false,
                durable:    true,
                exclusive:  false,
                auto_delete: false,
                nowait:     false,
                arguments: [
                    'x-dead-letter-exchange'    => ['S', 'messages.dlx'],
                    'x-dead-letter-routing-key' => ['S', "dead.{$type}"],
                    'x-message-ttl'             => ['I', 300_000], // 5 menit
                ],
            );
            $channel->queue_bind($queueName, 'messages', "inbound.{$type}");

            // messages.dlx is a DIRECT exchange, so '#' is a literal key and
            // never matches anything. Bind the actual dead-letter key per type,
            // otherwise expired messages are dropped instead of retained.
            $channel->queue_bind('dead.letters', 'messages.dlx', "dead.{$type}");
        }
    }

    // ── Private: ack/nack helpers ─────────────────────────────────────────────

    private function ack(AMQPMessage $msg): void
    {
        $msg->getChannel()->basic_ack($msg->getDeliveryTag());
    }

    private function nack(AMQPMessage $msg, bool $requeue): void
    {
        $msg->getChannel()->basic_nack(
            delivery_tag: $msg->getDeliveryTag(),
            multiple:     false,
            requeue:      $requeue,
        );
    }

    // ── Private: signal handlers ──────────────────────────────────────────────

    private function registerSignalHandlers(): void
    {
        if (! extension_loaded('pcntl')) {
            return;
        }

        $handler = function (): void {
            $this->info('[rabbitmq:consume] Signal received — finishing current message then stopping...');
            $this->shouldStop = true;
        };

        pcntl_signal(SIGTERM, $handler);
        pcntl_signal(SIGINT,  $handler);
    }

    // ── Private: record failure for undeserializable messages ────────────────

    private function recordUnparseable(?array $payload, Throwable $e): void
    {
        if ($payload === null) {
            return; // JSON parse gagal total — tidak ada data untuk disimpan
        }

        try {
            FailedWebhookEvent::create([
                'event_id'     => $payload['event_id']     ?? 'unknown',
                'company_id'   => $payload['company_id']   ?? 'unknown',
                'channel_type' => $payload['channel_type'] ?? 'unknown',
                'payload'      => json_encode([
                    'event_id'     => $payload['event_id']     ?? null,
                    'channel_type' => $payload['channel_type'] ?? null,
                    'content_type' => $payload['content_type'] ?? null,
                ]),
                'error'   => $e->getMessage(),
                'attempt' => 0,
            ]);
        } catch (Throwable $dbErr) {
            Log::error('Failed to record unparseable message to DB', ['error' => $dbErr->getMessage()]);
        }
    }
}
