import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { appendFile } from "fs/promises"
import BackupManagerService from "../../../modules/backup-manager/service"

export const AUTHENTICATE = true

const LOG_FILE = "/tmp/backup-plugin.log"

const logBackupRoute = async (event: string, details?: Record<string, unknown>) => {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      scope: "route",
      event,
      ...(details || {}),
    })
    await appendFile(LOG_FILE, `${line}\n`)
  } catch {
    // ignore logging failures
  }
}

// GET /admin/backups — list stats, records, and drive files
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const service: BackupManagerService = req.scope.resolve("backupManager")
  
  try {
    await logBackupRoute("get_start")
    const config = await service.getConfig()
    const stats = await service.getBackupStats().catch(() => ({
      totalBackups: 0, lastBackupAt: null, nextBackupAt: null, totalSize: 0, backups: []
    }))
    const driveFiles = await service.listDriveBackups().catch(() => [])
    
    const envDbUrl = process.env.DATABASE_URL || ""
    await logBackupRoute("get_success", {
      hasConfig: Boolean(config),
      backupsCount: stats.backups?.length || 0,
      driveFilesCount: driveFiles.length,
    })
    res.json({ stats, config, driveFiles, env: { databaseUrl: envDbUrl } })
  } catch (err: any) {
    await logBackupRoute("get_error", { message: err?.message, stack: err?.stack, type: err?.constructor?.name })
    console.error("[BackupPlugin] POST /admin/backups error:", err.message, err.stack)
    res.status(500).json({ error: err.message })
  }
}

// POST /admin/backups — create manual backup / configure / test
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const service: BackupManagerService = req.scope.resolve("backupManager")
  const { action, config, backupId } = (req.body || {}) as any

  try {
    await logBackupRoute("post_start", {
      action,
      hasConfig: Boolean(config),
      hasBackupId: Boolean(backupId),
    })
    switch (action) {
      case "configure":
        await service.configure(config)
        await service.startScheduledBackup().catch(e => 
          console.warn("[BackupPlugin] startScheduledBackup warning:", e.message)
        )
        await logBackupRoute("configure_success")
        // Auto-register webhook if GitHub token is configured
        if (config?.githubToken && config?.githubRepoUrl) {
          const storeUrl = `${req.protocol}://${req.get("host")}`
          service.autoRegisterWebhook(storeUrl).then(r =>
            console.log("[BackupPlugin] Webhook auto-register:", r.message)
          ).catch(() => {})
        }
        return res.json({ success: true, message: "Configuration saved" })

      case "register-webhook": {
        const storeUrl = (req.body as any)?.storeUrl || `${req.protocol}://${req.get("host")}`
        const regResult = await service.autoRegisterWebhook(storeUrl)
        return res.json(regResult)
      }

      case "backup":
        const record = await service.createBackup("manual")
        await logBackupRoute("backup_success", { recordId: record.id, fileName: record.fileName })
        return res.json({ success: true, record })

      case "restore":
        if (!backupId) return res.status(400).json({ error: "backupId required" })
        const result = await service.restoreBackup(backupId)
        return res.json(result)

      case "test-drive":
        const testResult = await service.testDriveConnection()
        return res.json(testResult)

      case "deploy-all":
        const deployResults = await service.triggerDeployAll(config?.version)
        return res.json({ success: true, results: deployResults })

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` })
    }
  } catch (err: any) {
    await logBackupRoute("post_error", {
      action,
      message: err?.message,
      stack: err?.stack,
      type: err?.constructor?.name,
    })
    res.status(500).json({ 
      error: err.message,
      stack: err.stack,
      type: err.constructor?.name,
    })
  }
}
