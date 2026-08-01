export const config = { runtime: 'edge' };

export default async function handler(request) {
  const { searchParams } = new URL(request.url);
  const target = searchParams.get('url');

  if (!target) {
    return new Response('Eksik "url" parametresi', { status: 400 });
  }

  // Yalnızca http/https hedeflerine izin ver (kötüye kullanımı önlemek için)
  let targetUrl;
  try {
    targetUrl = new URL(target);
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      return new Response('Geçersiz protokol', { status: 400 });
    }
  } catch {
    return new Response('Geçersiz url', { status: 400 });
  }

  const upstreamHeaders = {};
  const range = request.headers.get('range');
  if (range) upstreamHeaders['range'] = range;

  let upstream;
  try {
    upstream = await fetch(targetUrl.toString(), { headers: upstreamHeaders });
  } catch (err) {
    return new Response('Panele ulaşılamadı: ' + err.message, { status: 502 });
  }

  const respHeaders = new Headers();
  const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];
  passthrough.forEach((h) => {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  });
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Access-Control-Allow-Headers', '*');
  respHeaders.set('Access-Control-Allow-Methods', 'GET, OPTIONS');

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders
  });
}
