export default {
  async fetch(request) {
    return Response.json({
      ok: true,
      name: "pg-lighttrace",
      path: new URL(request.url).pathname,
    });
  },
};
