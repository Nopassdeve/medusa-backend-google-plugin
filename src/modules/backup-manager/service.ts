import { MedusaService } from "@medusajs/framework/utils"
import { exec } from "child_process"
import { promises as fs, createWriteStream, createReadStream } from "fs"
import path from "path"
import os from "os"
import { Readable } from "stream"
import archiverLib from "archiver"
import { drive_v3, google } from "googleapis"
import cronLib from "node-cron"
import { Client } from "pg"

// archiver is a CommonJS module — v7 exports a function, v8 exports {ZipArchive,TarArchive,...}
// Normalize to a factory function compatible with both versions.
const _archiverMod: any = (archiverLib as any).default || archiverLib
function createArchive(format: "zip" | "tar", opts?: any) {
  if (typeof _archiverMod === "function") {
    return _archiverMod(format, opts)
  }
  // archiver v8+
  if (format === "zip" && _archiverMod.ZipArchive) return new _archiverMod.ZipArchive(opts)
  if (format === "tar" && _archiverMod.TarArchive) return new _archiverMod.TarArchive(opts)
  throw new Error(`Unsupported archiver format: ${format}`)
}
// node-cron is a CommonJS module
const cron: typeof cronLib = (cronLib as any).default || cronLib

// ============================================================
// Types
// ============================================================

export interface BackupConfig {
  /** Google Drive folder ID where backups are stored */
  googleDriveFolderId: string
  /** Google service account JSON key (as string) */
  googleServiceAccountKey: string
  /** Google OAuth client ID */
  googleOauthClientId?: string
  /** Google OAuth client secret */
  googleOauthClientSecret?: string
  /** Google OAuth refresh token */
  googleOauthRefreshToken?: string
  /** Store name for backup file naming (defaults to STORE_NAME env var) */
  storeName?: string
  /** Database connection URL */
  databaseUrl: string
  /** Paths to include in file backup (relative to project root) */
  backupPaths: string[]
  /** Cron expression for scheduled backup (default: daily at 3AM) */
  cronExpression: string
  /** Number of days to retain backups */
  retentionDays: number
  /** GitHub repo URL for auto-deploy */
  githubRepoUrl?: string
  /** GitHub Personal Access Token for auto-registering webhooks */
  githubToken?: string
}

export interface BackupRecord {
  id: string
  fileName: string
  googleDriveFileId: string
  size: number
  type: "scheduled" | "manual" | "pre-deploy"
  status: "success" | "failed" | "in-progress"
  createdAt: Date
  completedAt?: Date
  errorMessage?: string
}

export interface BackupStats {
  totalBackups: number
  lastBackupAt: Date | null
  nextBackupAt: Date | null
  totalSize: number
  backups: BackupRecord[]
}

export interface DeployRecord {
  id: string
  storeName: string
  version: string
  status: "deployed" | "failed"
  deployedAt: Date
  errorMessage?: string
}

// ============================================================
// Service
// ============================================================

class BackupManagerService extends MedusaService({
  // We manage our own storage via Google Drive, no DB models needed
}) {
  private config_: BackupConfig | null = null
  private cronJob_: ReturnType<typeof cron.schedule> | null = null
  private backupRecords_: BackupRecord[] = []
  private deployRecords_: DeployRecord[] = []
  private driveClient_: drive_v3.Drive | null = null
  private recordsFilePath_: string = ""
  private dbConfigTableReady_: boolean = false

  private async log_(event: string, details?: Record<string, unknown>): Promise<void> {
    try {
      await fs.appendFile(
        "/tmp/backup-plugin.log",
        `${JSON.stringify({
          ts: new Date().toISOString(),
          scope: "service",
          event,
          ...(details || {}),
        })}\n`
      )
    } catch {
      // ignore logging failures
    }
  }

  // ----------------------------------------------------------
  // DB Config Persistence (uses PostgreSQL directly)
  // ----------------------------------------------------------

  private async ensureConfigTable_(): Promise<void> {
    if (this.dbConfigTableReady_) return
    const dbUrl = this.config_?.databaseUrl || process.env.DATABASE_URL
    if (!dbUrl) return
    const client = new Client({ connectionString: dbUrl })
    try {
      await client.connect()
      await client.query(`
        CREATE TABLE IF NOT EXISTS backup_plugin_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `)
      this.dbConfigTableReady_ = true
    } catch (e) {
      console.error("[BackupPlugin] ensureConfigTable_ error:", e)
    } finally {
      await client.end().catch(() => {})
    }
  }

  private async saveConfigToDb_(config: BackupConfig): Promise<void> {
    const dbUrl = config.databaseUrl || process.env.DATABASE_URL
    if (!dbUrl) return
    const client = new Client({ connectionString: dbUrl })
    try {
      await client.connect()
      await client.query(`
        CREATE TABLE IF NOT EXISTS backup_plugin_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `)
      await client.query(`
        INSERT INTO backup_plugin_config (key, value, updated_at)
        VALUES ('config', $1, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
      `, [JSON.stringify(config)])
      this.dbConfigTableReady_ = true
    } catch (e) {
      console.error("[BackupPlugin] saveConfigToDb_ error:", e)
    } finally {
      await client.end().catch(() => {})
    }
  }

  private async loadConfigFromDb_(): Promise<BackupConfig | null> {
    const dbUrl = process.env.DATABASE_URL
    if (!dbUrl) return null
    const client = new Client({ connectionString: dbUrl })
    try {
      await client.connect()
      // Table might not exist yet
      const tableCheck = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables WHERE table_name = 'backup_plugin_config'
        ) AS exists
      `)
      if (!tableCheck.rows[0]?.exists) return null
      const res = await client.query(`SELECT value FROM backup_plugin_config WHERE key = 'config'`)
      if (res.rows.length === 0) return null
      return JSON.parse(res.rows[0].value) as BackupConfig
    } catch {
      return null
    } finally {
      await client.end().catch(() => {})
    }
  }

  // ----------------------------------------------------------
  // Configuration
  // ----------------------------------------------------------

  async configure(config: Partial<BackupConfig>): Promise<BackupConfig> {
    const defaults: BackupConfig = {
      googleDriveFolderId: "",
      googleServiceAccountKey: "",
      googleOauthClientId: "",
      googleOauthClientSecret: "",
      googleOauthRefreshToken: "",
      databaseUrl: process.env.DATABASE_URL || "postgres://localhost:5432/medusa",
      backupPaths: [
        // ── Backend source code ──────────────────────────────
        "src",
        "medusa-config.ts",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
        ".env",
        "migrations",
        "scripts",
        "ecosystem.config.js",
        // ── Storefront source code ────────────────────────────
        "../storefront/src",
        "../storefront/public",
        "../storefront/next.config.js",
        "../storefront/next-sitemap.js",
        "../storefront/tailwind.config.js",
        "../storefront/postcss.config.js",
        "../storefront/eslint.config.mjs",
        "../storefront/tsconfig.json",
        "../storefront/package.json",
        "../storefront/package-lock.json",
        "../storefront/.env.local",
        "../storefront/scripts",
        "../storefront/preset",
        // ── Root-level config ─────────────────────────────────
        "../ecosystem.config.js",
        "../start-prod.sh",
      ],
      cronExpression: "0 3 * * *", // Daily at 3 AM
      retentionDays: 7,
      githubRepoUrl: "",
    }

    this.config_ = { ...defaults, ...(this.config_ || {}), ...config }
    // Persist to database
    await this.saveConfigToDb_(this.config_)
    // Ensure Google Drive client is initialized (don't throw if key is invalid)
    if (
      this.config_.googleDriveFolderId &&
      (
        this.config_.googleServiceAccountKey ||
        (this.config_.googleOauthClientId && this.config_.googleOauthClientSecret && this.config_.googleOauthRefreshToken)
      )
    ) {
      try { this.initDriveClient_() } catch (e: any) {
        console.warn("[BackupPlugin] Drive client init warning:", e.message)
      }
    }
    return this.config_
  }

  async getConfig(): Promise<BackupConfig | null> {
    // Load from DB if not in memory (e.g. after restart)
    if (!this.config_) {
      const dbConfig = await this.loadConfigFromDb_()
      if (dbConfig) {
        this.config_ = dbConfig
        if (
          this.config_.googleDriveFolderId &&
          (
            this.config_.googleServiceAccountKey ||
            (this.config_.googleOauthClientId && this.config_.googleOauthClientSecret && this.config_.googleOauthRefreshToken)
          )
        ) {
          try { this.initDriveClient_() } catch {}
        }
      }
    }
    return this.config_
  }

  // ----------------------------------------------------------
  // Google Drive Client
  // ----------------------------------------------------------

  private initDriveClient_(): drive_v3.Drive {
    const oauthClientId = this.config_?.googleOauthClientId || ""
    const oauthClientSecret = this.config_?.googleOauthClientSecret || ""
    const oauthRefreshToken = this.config_?.googleOauthRefreshToken || ""

    if (oauthClientId && oauthClientSecret && oauthRefreshToken) {
      const auth = new google.auth.OAuth2(oauthClientId, oauthClientSecret)
      auth.setCredentials({ refresh_token: oauthRefreshToken })
      this.driveClient_ = google.drive({ version: "v3", auth })
      return this.driveClient_
    }

    if (this.config_?.googleServiceAccountKey) {
      const key = JSON.parse(this.config_.googleServiceAccountKey)
      const auth = new google.auth.GoogleAuth({
        credentials: key,
        scopes: ["https://www.googleapis.com/auth/drive"],
      })
      this.driveClient_ = google.drive({ version: "v3", auth })
      return this.driveClient_
    }

    throw new Error("Google Drive 未配置。请填写 OAuth Client ID、Client Secret、Refresh Token，或提供服务账号 JSON。")
  }

  private normalizeDriveError_(err: any): Error {
    const rawMessage = String(err?.message || "")

    if (/File not found/i.test(rawMessage)) {
      const isOAuth = !!(this.config_?.googleOauthClientId && this.config_?.googleOauthRefreshToken)
      if (isOAuth) {
        return new Error(
          `Google Drive 文件夹 ID 无效或 OAuth 授权账号无访问权限。请确认文件夹 ID 为 ${this.config_?.googleDriveFolderId || "未设置"}，并确保该文件夹在已授权的 Google 账号的 My Drive 或 Shared Drive 下，且授权账号有编辑者权限。`
        )
      }
      return new Error(
        `Google Drive 文件夹 ID 无效或服务账号没有访问权限。请确认文件夹 ID 为 ${this.config_?.googleDriveFolderId || "未设置"}，并把服务账号邮箱共享到该文件夹（编辑者权限）。`
      )
    }

    if (/storage quota/i.test(rawMessage) || /Service Accounts do not have storage quota/i.test(rawMessage)) {
      return new Error(
        "当前使用的是 Google Service Account，它不能写入普通 My Drive 文件夹，因为没有个人存储配额。请改用 Shared Drive（共享云端硬盘）里的文件夹，或改用具备实际存储配额的 OAuth 用户授权。"
      )
    }

    if (/insufficient/i.test(rawMessage) || /permission/i.test(rawMessage) || /forbidden/i.test(rawMessage)) {
      return new Error("Google Drive 权限不足。请确认已启用 Drive API，并把服务账号加入目标文件夹为编辑者。")
    }

    return err instanceof Error ? err : new Error(rawMessage || "Google Drive 操作失败")
  }

  private async getDriveFolderInfo_(): Promise<{ id: string; name: string; driveId?: string | null; mimeType?: string | null }> {
    const drive = this.getDrive_()
    try {
      const response = await drive.files.get({
        fileId: this.config_!.googleDriveFolderId,
        fields: "id,name,mimeType,driveId",
        supportsAllDrives: true,
      })

      return {
        id: response.data.id || this.config_!.googleDriveFolderId,
        name: response.data.name || this.config_!.googleDriveFolderId,
        driveId: response.data.driveId || null,
        mimeType: response.data.mimeType || null,
      }
    } catch (err: any) {
      throw this.normalizeDriveError_(err)
    }
  }

  private getDrive_(): drive_v3.Drive {
    if (!this.driveClient_) {
      if (
        this.config_?.googleServiceAccountKey ||
        (this.config_?.googleOauthClientId && this.config_?.googleOauthClientSecret && this.config_?.googleOauthRefreshToken)
      ) {
        return this.initDriveClient_()
      }
      throw new Error("Google Drive 未配置。请先保存 OAuth Client ID、Client Secret、Refresh Token 和 Drive 文件夹 ID。")
    }
    return this.driveClient_
  }

  // ----------------------------------------------------------
  // Backup Records Management (in-memory + file persistence)
  // ----------------------------------------------------------

  private initRecordsFile_(projectRoot: string): void {
    this.recordsFilePath_ = path.join(projectRoot, ".backup-records.json")
  }

  private async loadRecords_(): Promise<void> {
    if (!this.recordsFilePath_) return
    try {
      const data = await fs.readFile(this.recordsFilePath_, "utf-8")
      const parsed = JSON.parse(data)
      this.backupRecords_ = parsed.backups || []
      this.deployRecords_ = parsed.deploys || []
    } catch {
      this.backupRecords_ = []
      this.deployRecords_ = []
    }
  }

  private async saveRecords_(): Promise<void> {
    if (!this.recordsFilePath_) return
    await fs.writeFile(
      this.recordsFilePath_,
      JSON.stringify({ backups: this.backupRecords_, deploys: this.deployRecords_ }, null, 2)
    )
  }

  private addRecord_(record: BackupRecord): void {
    this.backupRecords_.unshift(record)
    this.saveRecords_()
  }

  private updateRecord_(id: string, updates: Partial<BackupRecord>): void {
    const idx = this.backupRecords_.findIndex((r) => r.id === id)
    if (idx >= 0) {
      this.backupRecords_[idx] = { ...this.backupRecords_[idx], ...updates }
      this.saveRecords_()
    }
  }

  // ----------------------------------------------------------
  // Database Backup
  // ----------------------------------------------------------

  private async backupDatabase_(tmpDir: string): Promise<string> {
    const dbUrl = new URL(this.config_!.databaseUrl)
    const outputFile = path.join(tmpDir, "database.sql")

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PGPASSWORD: dbUrl.password || "",
    }

    const command = [
      "pg_dump",
      "-h", dbUrl.hostname || "localhost",
      "-p", dbUrl.port || "5432",
      "-U", dbUrl.username || "postgres",
      "-d", dbUrl.pathname.replace("/", ""),
      "-f", outputFile,
      "--no-owner",
      "--no-acl",
    ].join(" ")

    return new Promise((resolve, reject) => {
      exec(command, { env, timeout: 300000 }, (error, stdout, stderr) => {
        if (error && !stderr.includes("WARNING")) {
          reject(new Error(`pg_dump failed: ${stderr || error.message}`))
        } else {
          resolve(outputFile)
        }
      })
    })
  }

  // ----------------------------------------------------------
  // Files Backup
  // ----------------------------------------------------------

  private async backupFiles_(tmpDir: string, projectRoot: string): Promise<string> {
    const archivePath = path.join(tmpDir, "files.zip")

    return new Promise((resolve, reject) => {
      const output = createWriteStream(archivePath)
      const archive = createArchive("zip", { zlib: { level: 9 } })

      output.on("close", () => resolve(archivePath))
      archive.on("error", reject)

      archive.pipe(output)

      for (const relPath of this.config_!.backupPaths) {
        // Support absolute paths (e.g. /etc/nginx/...)
        const isAbsolute = relPath.startsWith("/")
        const fullPath = isAbsolute ? relPath : path.join(projectRoot, relPath)

        // Normalize archive entry name:
        //   "/etc/nginx/foo.conf"  → "server/etc/nginx/foo.conf"
        //   "../storefront/src"    → "storefront/src"
        //   "src"                  → "backend/src"
        let archiveName: string
        if (isAbsolute) {
          archiveName = "server" + relPath
        } else if (relPath.startsWith("../")) {
          archiveName = relPath.replace(/^(\.\.\/)+/, "")
        } else {
          archiveName = `backend/${relPath}`
        }

        try {
          const stat = require("fs").statSync(fullPath)
          if (stat.isDirectory()) {
            archive.directory(fullPath, archiveName)
          } else {
            archive.file(fullPath, { name: archiveName })
          }
        } catch {
          // Path doesn't exist, skip silently
        }
      }

      archive.finalize()
    })
  }

  // ----------------------------------------------------------
  // Upload to Google Drive
  // ----------------------------------------------------------

  private async uploadToDrive_(filePath: string, fileName: string): Promise<{ fileId: string; size: number }> {
    const drive = this.getDrive_()
    const stats = await fs.stat(filePath)

    let response: any
    try {
      response = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: [this.config_!.googleDriveFolderId],
        },
        media: {
          body: createReadStream(filePath),
        },
        supportsAllDrives: true,
      })
    } catch (err: any) {
      throw this.normalizeDriveError_(err)
    }

    return {
      fileId: response.data.id!,
      size: stats.size,
    }
  }

  // ----------------------------------------------------------
  // Delete from Google Drive (cleanup old backups)
  // ----------------------------------------------------------

  private async deleteFromDrive_(fileId: string): Promise<void> {
    const drive = this.getDrive_()
    await drive.files.delete({ fileId, supportsAllDrives: true })
  }

  private async cleanupOldBackups_(): Promise<void> {
    const drive = this.getDrive_()
    const retentionMs = (this.config_!.retentionDays || 7) * 24 * 60 * 60 * 1000
    const cutoff = new Date(Date.now() - retentionMs)

    // Get records older than retention
    const oldRecords = this.backupRecords_.filter(
      (r) => new Date(r.createdAt).getTime() < cutoff.getTime()
    )

    for (const record of oldRecords) {
      try {
        await this.deleteFromDrive_(record.googleDriveFileId)
        this.backupRecords_ = this.backupRecords_.filter((r) => r.id !== record.id)
      } catch (err) {
        console.error(`[BackupPlugin] Failed to delete old backup ${record.fileName}:`, err)
      }
    }
    this.saveRecords_()
  }

  // ----------------------------------------------------------
  // Main Backup Operation
  // ----------------------------------------------------------

  async createBackup(
    type: BackupRecord["type"] = "manual",
    projectRoot?: string
  ): Promise<BackupRecord> {
    await this.log_("create_backup_start", { type, projectRoot: projectRoot || process.cwd() })
    // Ensure config is loaded (may be null after restart if not yet called getConfig)
    if (!this.config_) {
      await this.getConfig()
    }
    if (!(this.config_?.googleServiceAccountKey || (this.config_?.googleOauthClientId && this.config_?.googleOauthClientSecret && this.config_?.googleOauthRefreshToken))) {
      await this.log_("create_backup_not_configured")
      throw new Error("备份插件尚未配置。请先保存 Google OAuth Client ID、Client Secret、Refresh Token 和 Drive 文件夹 ID。")
    }

    const root = projectRoot || process.cwd()
    this.initRecordsFile_(root)
    await this.loadRecords_()

    const recordId = `backup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const storeName = (this.config_?.storeName || process.env.STORE_NAME || process.env.APP_NAME || "medusa").toLowerCase().replace(/[^a-z0-9]/g, "-")
    const fileName = `${storeName}-backup-${timestamp}.tar.gz`
    await this.log_("create_backup_config_loaded", {
      storeName,
      fileName,
      hasDriveFolder: Boolean(this.config_.googleDriveFolderId),
      hasServiceKey: Boolean(this.config_.googleServiceAccountKey),
      hasOauth: Boolean(this.config_.googleOauthClientId && this.config_.googleOauthClientSecret && this.config_.googleOauthRefreshToken),
      dbHost: (() => {
        try {
          return new URL(this.config_.databaseUrl).hostname
        } catch {
          return "invalid"
        }
      })(),
    })
    
    const record: BackupRecord = {
      id: recordId,
      fileName,
      googleDriveFileId: "",
      size: 0,
      type,
      status: "in-progress",
      createdAt: new Date(),
    }
    this.addRecord_(record)

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-"))

    try {
      // Step 1: Backup Database
      await this.log_("create_backup_step", { step: "backup_database_start" })
      const dbFile = await this.backupDatabase_(tmpDir)
      await this.log_("create_backup_step", { step: "backup_database_done", dbFile })

      // Step 2: Backup Files
      await this.log_("create_backup_step", { step: "backup_files_start" })
      const filesArchive = await this.backupFiles_(tmpDir, root)
      await this.log_("create_backup_step", { step: "backup_files_done", filesArchive })

      // Step 3: Create final combined archive
      const combinedPath = path.join(tmpDir, fileName)
      await this.log_("create_backup_step", { step: "create_tar_start", combinedPath })
      await this.createTarGz_([dbFile, filesArchive], combinedPath)
      await this.log_("create_backup_step", { step: "create_tar_done", combinedPath })

      // Step 4: Upload to Google Drive
      await this.log_("create_backup_step", { step: "upload_drive_start" })
      const { fileId, size } = await this.uploadToDrive_(combinedPath, fileName)
      await this.log_("create_backup_step", { step: "upload_drive_done", fileId, size })

      // Step 5: Update record
      record.googleDriveFileId = fileId
      record.size = size
      record.status = "success"
      record.completedAt = new Date()
      this.updateRecord_(recordId, record)

      // Step 6: Cleanup old backups
      await this.cleanupOldBackups_()
      await this.log_("create_backup_success", { recordId, fileName, fileId, size })

      return record
    } catch (err: any) {
      await this.log_("create_backup_error", { message: err?.message, stack: err?.stack, type: err?.constructor?.name })
      record.status = "failed"
      record.errorMessage = err.message
      record.completedAt = new Date()
      this.updateRecord_(recordId, record)
      throw err
    } finally {
      // Clean temp files
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  }

  private async createTarGz_(files: string[], outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = createWriteStream(outputPath)
      const archive = createArchive("tar", { gzip: true })
      
      output.on("close", resolve)
      archive.on("error", reject)
      archive.pipe(output)

      for (const file of files) {
        archive.file(file, { name: path.basename(file) })
      }

      archive.finalize()
    })
  }

  // ----------------------------------------------------------
  // Restore
  // ----------------------------------------------------------

  async restoreBackup(backupId: string, projectRoot?: string): Promise<{ success: boolean; message: string }> {
    if (!this.config_) await this.getConfig()
    if (!this.config_) throw new Error("Not configured")

    const root = projectRoot || process.cwd()
    this.initRecordsFile_(root)
    await this.loadRecords_()

    const record = this.backupRecords_.find((r) => r.id === backupId)
    if (!record) throw new Error(`Backup ${backupId} not found`)

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "restore-"))
    const downloadPath = path.join(tmpDir, record.fileName)

    try {
      // Download from Google Drive
      const drive = this.getDrive_()
      const dest = createWriteStream(downloadPath)
      const response = await drive.files.get(
        { fileId: record.googleDriveFileId, alt: "media", supportsAllDrives: true },
        { responseType: "stream" }
      )
      
      await new Promise<void>((resolve, reject) => {
        response.data
          .pipe(dest)
          .on("finish", resolve)
          .on("error", reject)
      })

      // Extract
      const extractDir = path.join(tmpDir, "extracted")
      await fs.mkdir(extractDir)
      await this.extractTarGz_(downloadPath, extractDir)

      // Restore database
      const dbFile = path.join(extractDir, "database.sql")
      if (await this.fileExists_(dbFile)) {
        await this.restoreDatabase_(dbFile)
      }

      // Restore files
      const filesArchive = path.join(extractDir, "files.zip")
      if (await this.fileExists_(filesArchive)) {
        await this.extractZip_(filesArchive, root)
      }

      return { success: true, message: "Backup restored successfully" }
    } catch (err: any) {
      return { success: false, message: `Restore failed: ${err.message}` }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  }

  private async restoreDatabase_(sqlFile: string): Promise<void> {
    const dbUrl = new URL(this.config_!.databaseUrl)
    const command = [
      "psql",
      "-h", dbUrl.hostname || "localhost",
      "-p", dbUrl.port || "5432",
      "-U", dbUrl.username || "postgres",
      "-d", dbUrl.pathname.replace("/", ""),
      "-f", sqlFile,
    ].join(" ")

    return new Promise((resolve, reject) => {
      exec(command, {
        env: { ...process.env, PGPASSWORD: dbUrl.password || "" },
        timeout: 600000,
      }, (error, stdout, stderr) => {
        if (error) reject(new Error(`Database restore failed: ${stderr || error.message}`))
        else resolve()
      })
    })
  }

  private async extractTarGz_(archivePath: string, outputDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      exec(
        `tar -xzf "${archivePath}" -C "${outputDir}"`,
        { timeout: 300000 },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`Extract failed: ${stderr || error.message}`))
          else resolve()
        }
      )
    })
  }

  private async extractZip_(zipPath: string, outputDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      exec(
        `unzip -o "${zipPath}" -d "${outputDir}"`,
        { timeout: 300000 },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`Zip extract failed: ${stderr || error.message}`))
          else resolve()
        }
      )
    })
  }

  private async fileExists_(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  // ----------------------------------------------------------
  // Scheduled Backup
  // ----------------------------------------------------------

  async startScheduledBackup(projectRoot?: string): Promise<void> {
    if (this.cronJob_) {
      this.cronJob_.stop()
    }

    const root = projectRoot || process.cwd()
    this.initRecordsFile_(root)

    if (!this.config_?.cronExpression) return

    this.cronJob_ = cron.schedule(this.config_.cronExpression, async () => {
      try {
        await this.loadRecords_()
        await this.createBackup("scheduled", root)
      } catch (err: any) {
        console.error(`[BackupPlugin] Scheduled backup failed:`, err.message)
      }
    })
  }

  stopScheduledBackup(): void {
    if (this.cronJob_) {
      this.cronJob_.stop()
      this.cronJob_ = null
    }
  }

  // ----------------------------------------------------------
  // Stats & History
  // ----------------------------------------------------------

  async getBackupStats(projectRoot?: string): Promise<BackupStats> {
    const root = projectRoot || process.cwd()
    this.initRecordsFile_(root)
    await this.loadRecords_()

    const successfulBackups = this.backupRecords_.filter((r) => r.status === "success")
    const lastBackup = successfulBackups[0] || null

    // Calculate next backup time from cron expression
    let nextBackupAt: Date | null = null
    if (this.config_?.cronExpression) {
      try {
        // Simple calculation: next occurrence based on current time
        const now = new Date()
        // Parse cron: min hour * * *
        const parts = this.config_.cronExpression.split(" ")
        const hour = parseInt(parts[1]) || 3
        const min = parseInt(parts[0]) || 0
        nextBackupAt = new Date(now)
        nextBackupAt.setHours(hour, min, 0, 0)
        if (nextBackupAt <= now) {
          nextBackupAt.setDate(nextBackupAt.getDate() + 1)
        }
      } catch {
        nextBackupAt = null
      }
    }

    return {
      totalBackups: successfulBackups.length,
      lastBackupAt: lastBackup?.completedAt || null,
      nextBackupAt,
      totalSize: successfulBackups.reduce((sum, r) => sum + r.size, 0),
      backups: this.backupRecords_,
    }
  }

  async getBackups(): Promise<BackupRecord[]> {
    return this.backupRecords_
  }

  // ----------------------------------------------------------
  // Google Drive: List backup files
  // ----------------------------------------------------------

  async listDriveBackups(): Promise<Array<{ id: string; name: string; size: string; createdTime: string }>> {
    if (!this.config_?.googleDriveFolderId) return []

    const drive = this.getDrive_()
    const response = await drive.files.list({
      q: `'${this.config_.googleDriveFolderId}' in parents and trashed = false`,
      fields: "files(id, name, size, createdTime)",
      orderBy: "createdTime desc",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })

    return (response.data.files || []).map((f: any) => ({
      id: f.id!,
      name: f.name!,
      size: f.size || "0",
      createdTime: f.createdTime!,
    }))
  }

  // ----------------------------------------------------------
  // Multi-Store Deployment
  // ----------------------------------------------------------

  // ----------------------------------------------------------
  // Auto-register GitHub Webhook
  // ----------------------------------------------------------

  async autoRegisterWebhook(storeBaseUrl: string): Promise<{ success: boolean; message: string }> {
    if (!this.config_?.githubToken || !this.config_?.githubRepoUrl) {
      return { success: false, message: "GitHub Token 或仓库地址未配置" }
    }

    const webhookUrl = `${storeBaseUrl.replace(/\/$/, "")}/store/deploy`
    const repoFullName = this.extractRepoFullName_(this.config_.githubRepoUrl)
    if (!repoFullName) return { success: false, message: "无法解析 GitHub 仓库地址" }

    try {
      // Check if webhook already exists
      const existingHooks = await this.listGitHubWebhooks_(repoFullName)
      const alreadyExists = existingHooks.some(
        (hook: any) => hook.config?.url === webhookUrl
      )
      if (alreadyExists) {
        return { success: true, message: `Webhook 已存在：${webhookUrl}` }
      }

      // Create webhook via GitHub API
      const response = await fetch(`https://api.github.com/repos/${repoFullName}/hooks`, {
        method: "POST",
        headers: {
          "Authorization": `token ${this.config_.githubToken}`,
          "Content-Type": "application/json",
          "Accept": "application/vnd.github.v3+json",
        },
        body: JSON.stringify({
          name: "web",
          active: true,
          events: ["push"],
          config: {
            url: webhookUrl,
            content_type: "json",
            insecure_ssl: "0",
          },
        }),
      })

      if (response.ok) {
        return { success: true, message: `Webhook 注册成功：${webhookUrl}` }
      } else {
        const err = await response.text()
        return { success: false, message: `注册失败：${err}` }
      }
    } catch (err: any) {
      return { success: false, message: `注册异常：${err.message}` }
    }
  }

  private async listGitHubWebhooks_(repoFullName: string): Promise<any[]> {
    if (!this.config_?.githubToken) return []
    try {
      const response = await fetch(`https://api.github.com/repos/${repoFullName}/hooks`, {
        headers: {
          "Authorization": `token ${this.config_.githubToken}`,
          "Accept": "application/vnd.github.v3+json",
        },
      })
      return response.ok ? await response.json() as any[] : []
    } catch {
      return []
    }
  }

  private extractRepoFullName_(repoUrl: string): string | null {
    // Supports: git@github.com:owner/repo.git or https://github.com/owner/repo
    const match = repoUrl.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)
    return match ? match[1] : null
  }

  async registerStore(storeName: string, webhookUrl: string): Promise<void> {
    // Store registration is managed by the deployRecords
    this.deployRecords_.push({
      id: `store_${Date.now()}`,
      storeName,
      version: "1.0.0",
      status: "deployed",
      deployedAt: new Date(),
    })
    this.saveRecords_()
  }

  async triggerDeployAll(version?: string): Promise<DeployRecord[]> {
    const results: DeployRecord[] = []

    for (const store of this.deployRecords_) {
      try {
        const record: DeployRecord = {
          id: `deploy_${Date.now()}_${store.storeName}`,
          storeName: store.storeName,
          version: version || "latest",
          status: "deployed",
          deployedAt: new Date(),
        }
        results.push(record)
      } catch (err: any) {
        results.push({
          id: `deploy_${Date.now()}_${store.storeName}`,
          storeName: store.storeName,
          version: version || "latest",
          status: "failed",
          deployedAt: new Date(),
          errorMessage: err.message,
        })
      }
    }

    this.deployRecords_.unshift(...results)
    this.saveRecords_()
    return results
  }

  getDeployRecords(): DeployRecord[] {
    return this.deployRecords_
  }

  // ----------------------------------------------------------
  // Test Google Drive Connection
  // ----------------------------------------------------------

  async testDriveConnection(): Promise<{ connected: boolean; message: string }> {
    try {
      if (!this.config_ && !(await this.getConfig())) {
        return { connected: false, message: "未找到已保存的 Google Drive 配置。" }
      }

      const folder = await this.getDriveFolderInfo_()

      // Try a tiny temp upload to verify write access and quota.
      const drive = this.getDrive_()
      const tempName = `.backup-plugin-test-${Date.now()}.txt`
      const tempContent = Buffer.from("backup-plugin test", "utf-8")
      const created = await drive.files.create({
        requestBody: {
          name: tempName,
          parents: [this.config_!.googleDriveFolderId],
        },
        media: {
          mimeType: "text/plain",
          body: Readable.from(tempContent),
        },
        fields: "id",
        supportsAllDrives: true,
      }).catch((err: any) => {
        throw this.normalizeDriveError_(err)
      })

      if (created?.data?.id) {
        await drive.files.delete({ fileId: created.data.id, supportsAllDrives: true }).catch(() => {})
      }

      return {
        connected: true,
        message: folder.driveId
          ? `Google Drive 连接成功，可写入 Shared Drive 文件夹：${folder.name}`
          : `Google Drive 连接成功，可写入文件夹：${folder.name}`,
      }
    } catch (err: any) {
      return { connected: false, message: err.message || `Connection failed: ${err.message}` }
    }
  }
}

export default BackupManagerService
