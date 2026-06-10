import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

// POST /store/deploy — webhook endpoint for GitHub-triggered deployments
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { ref, repository } = (req.body || {}) as any
  
  console.log(`[BackupPlugin] Deploy webhook received: ${repository?.full_name} @ ${ref}`)

  // This endpoint is called by GitHub webhooks when code is pushed
  // In production, this would trigger pulling the latest code and restarting
  
  res.json({
    success: true,
    message: "Deploy webhook received",
    timestamp: new Date().toISOString(),
  })
}
