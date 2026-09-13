import { useEffect, useState } from 'react';
import api from '../../lib/api';
import { useAuthStore } from '../../stores/useAuthStore';

interface CompanyInfo {
  id?: string;
  name?: string;
  slug?: string;
  plan?: string;
  timezone?: string;
  locale?: string;
}

export default function CompanySettingsPage() {
  const authUser = useAuthStore((s) => s.user);
  const [company, setCompany] = useState<CompanyInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // /me 返回的 company 对象即当前公司信息；未来公司 CRUD API 就绪后可编辑
    api.get('/auth/me')
      .then((r) => setCompany(r.data?.company ?? null))
      .catch(() => setCompany(null))
      .finally(() => setLoading(false));
  }, []);

  const rows: Array<{ label: string; value?: string | null }> = [
    { label: '公司名称', value: company?.name ?? authUser?.name ?? null },
    { label: '公司标识', value: company?.slug ?? null },
    { label: '套餐', value: company?.plan ?? null },
    { label: '时区', value: company?.timezone ?? null },
    { label: '语言', value: company?.locale ?? null },
  ];

  return (
    <div className="p-6 max-w-3xl mx-auto h-full overflow-y-auto">
      <h1 className="text-xl font-bold text-gray-900">公司设置</h1>
      <p className="text-sm text-gray-400 mt-1 mb-6">当前公司的基本信息（只读）</p>

      {loading ? (
        <p className="text-gray-400 text-sm">加载中...</p>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between px-4 py-3">
              <span className="text-sm text-gray-500">{row.label}</span>
              <span className="text-sm font-medium text-gray-900">{row.value ?? '—'}</span>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-gray-400 mt-4">
        公司资料编辑功能将在后端公司管理 API 就绪后开放。
      </p>
    </div>
  );
}
