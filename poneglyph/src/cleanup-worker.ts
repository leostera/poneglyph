export default {
  fetch(): Response {
    return new Response("validation Worker is being retired", { status: 410 });
  },
};
