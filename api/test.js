export default {
  async fetch(request) {
    const url = new URL(request.url);
    console.log('test: pathname=' + url.pathname);

    // 测试直接转发到外部
    try {
      const resp = await fetch('https://httpbin.org/post', {
        method: 'POST',
        body: 'hello'
      });
      const text = await resp.text();
      return new Response('OK: ' + text.substring(0, 200), { status: 200 });
    } catch (e) {
      console.error('test failed: ' + e.message);
      return new Response('Error: ' + e.message, { status: 500 });
    }
  }
};
