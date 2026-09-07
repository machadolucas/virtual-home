export const dynamic = "force-dynamic";

/** Unauthenticated liveness probe. Deliberately reveals nothing but "the web process answers". */
export async function GET() {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
