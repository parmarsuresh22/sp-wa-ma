import { fomsErrorResponse, handleFoms } from '@/lib/foms/api'

type Params = { params: Promise<{ path: string[] }> }

/**
 * /api/aeda/**  — the API of AEDA Forms (the original FOMS backend,
 * route for route; see src/lib/foms/api.ts). Platform admin only while
 * the module is being tried out: everyone else gets "not found".
 */
async function handle(request: Request, { params }: Params): Promise<Response> {
  try {
    return await handleFoms(request, (await params).path ?? [])
  } catch (err) {
    return fomsErrorResponse(err)
  }
}

export const maxDuration = 60

export { handle as GET, handle as POST, handle as PUT, handle as DELETE }
