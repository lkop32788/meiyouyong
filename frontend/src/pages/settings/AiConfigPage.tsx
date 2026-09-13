import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../../lib/api';

interface Provider {
  id: string;
  label: string;
  base_url: string;
  model: string;
}

interface AiConfig {
  provider: string;
  base_url: string | null;
  model: string | null;
  has_key: boolean;
  providers: Provider[];
}

const EMPTY_FORM = { provider: 'openai', api_key: '', base_url: '', model: '' };

export default function AiConfigPage() {
  const [cfg, setCfg]       = useState<AiConfig | null>(null);
  const [form, setForm]     = useState({ ...EMPTY_FORM });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [testing, setTesting] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/ai-config')
      .then((r) => {
        const data: AiConfig = r.data.data;
        setCfg(data);
        setForm({
          provider: data.provider ?? 'openai',
          api_key: '',
          base_url: data.base_url ?? '',
          model: data.model ?? '',
        });
      })
      .catch(() => toast.error('加载 AI 配置失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const pickProvider = (id: string) => {
    setForm((f) => ({
      ...f,
      provider: id,
      // non-custom providers use backend defaults; custom keeps user values
      base_url: id === 'custom' ? f.base_url : '',
      model:    id === 'custom' ? f.model    : '',
    }));
  };

  const save = async () => {
    if (form.provider === 'custom' && !form.base_url.trim()) {
      toast.error('自定义接口需要填写 Base URL');
      return;
    }
    setSaving(true);
    try {
      await api.put('/ai-config', {
        provider: form.provider,
        api_key: form.api_key || null, // null = keep existing key
        base_url: form.provider === 'custom' ? form.base_url : null,
        model: form.model || null,
      });
      toast.success('AI 配置已保存');
      load();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const testConn = async () => {
    setTesting(true);
    try {
      const { data } = await api.post('/ai-config/test');
      if (data.data?.ok) {
        toast.success(`✅ 连接成功：${data.data.reply}`);
      } else {
        toast.error(`连接失败：${data.data?.error ?? '未知错误'}`);
      }
    } catch {
      toast.error('测试请求失败');
    } finally {
      setTesting(false);
    }
  };

  if (loading) return <div className="p-6 text-gray-400 text-sm">加载中...</div>;

  const isCustom = form.provider === 'custom';

  return (
    <div className="p-6 max-w-2xl mx-auto h-full overflow-y-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">AI 配置</h1>
        <p className="text-sm text-gray-400 mt-1">
          用于「AI 生成流程」等智能功能。支持 OpenAI、DeepSeek、xAI、Gemini、Claude，以及任何 OpenAI 兼容的自定义接口。
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        {/* Provider picker */}
        <div>
          <label className="block text-sm text-gray-600 mb-2">服务商</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {cfg?.providers.map((p) => (
              <button
                key={p.id}
                onClick={() => pickProvider(p.id)}
                className={`text-sm rounded-lg border px-3 py-2 transition ${
                  form.provider === p.id
                    ? 'border-brand-500 bg-brand-50 text-brand-700 font-medium'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* API Key */}
        <div>
          <label className="block text-sm text-gray-600 mb-1">
            API Key{cfg?.has_key ? '（已配置，留空保持不变）' : ''}
          </label>
          <input
            type="password"
            value={form.api_key}
            onChange={(e) => setForm({ ...form, api_key: e.target.value })}
            placeholder={cfg?.has_key ? '不修改请留空' : 'sk-...'}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          {cfg?.has_key && <p className="text-xs text-green-600 mt-1">✓ 已保存 API Key（加密存储，不回显）</p>}
        </div>

        {/* Custom endpoint fields */}
        {isCustom && (
          <>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Base URL（OpenAI 兼容）</label>
              <input
                value={form.base_url}
                onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                placeholder="https://your-host/v1"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <p className="text-xs text-gray-400 mt-1">兼容 vLLM、Ollama、OneAPI、智谱等 /chat/completions 接口</p>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">模型名称</label>
              <input
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                placeholder="例如：glm-4-flash、qwen2.5:7b"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </>
        )}

        {/* Non-custom model override */}
        {!isCustom && (
          <div>
            <label className="block text-sm text-gray-600 mb-1">模型（可选，留空用默认）</label>
            <input
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder={cfg?.providers.find((p) => p.id === form.provider)?.model ?? ''}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
          <button
            onClick={save}
            disabled={saving}
            className="bg-brand-600 hover:bg-brand-700 text-white text-sm rounded-lg px-4 py-2 transition disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存配置'}
          </button>
          <button
            onClick={testConn}
            disabled={testing || !cfg?.has_key}
            title={cfg?.has_key ? '向服务商发送测试消息' : '请先保存 API Key'}
            className="border border-gray-300 hover:border-brand-500 hover:text-brand-600 text-gray-600 text-sm rounded-lg px-4 py-2 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {testing ? '测试中…' : '测试连通'}
          </button>
        </div>
      </div>

      <p className="text-xs text-gray-400 mt-4">
        提示：Key 使用应用密钥加密存储，任何接口都不会回显明文。配置完成后即可在「机器人」页面使用 ✨ AI 生成流程。
      </p>
    </div>
  );
}
