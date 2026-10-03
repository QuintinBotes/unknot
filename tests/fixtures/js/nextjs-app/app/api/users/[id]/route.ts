export async function GET(request: Request, ctx: { params: { id: string } }) {
  return Response.json({ id: ctx.params.id });
}

export const POST = async (request: Request) => {
  const body = await request.json();
  return Response.json(body, { status: 201 });
};

export function helper() {
  return 1;
}
