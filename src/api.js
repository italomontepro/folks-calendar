export async function request(path, options = {}) {
  const usedToken=sessionStorage.getItem('folks-token')||'';
  const response = await fetch('/api'+path, {
    ...options,
    headers: {'Content-Type':'application/json', Authorization:'Bearer '+usedToken, ...options.headers},
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/login' && (sessionStorage.getItem('folks-token')||'')===usedToken) window.dispatchEvent(new Event('folks-unauthorized'));
    throw Object.assign(new Error(data.error || 'Não foi possível concluir a operação.'), { status: response.status });
  }
  return data;
}
export const roleNames = { owner:'Administrador FolkSales', admin:'Administrador', editor:'Editor', viewer:'Somente leitura' };
export const workspaceLink = (id, embed=false) => `${location.origin}/?workspace=${encodeURIComponent(id)}${embed?'&embed=1':''}`;
