/**
 * Medusa Google Backup Plugin
 * 
 * Features:
 * - Auto backup entire site (DB + files) to Google Drive
 * - Daily scheduled backups with 7-day rotation
 * - One-click restore from Google Drive
 * - Multi-store deployment via GitHub webhook
 * - Admin dashboard for management
 */

export { default as BackupManagerModule } from "./modules/backup-manager"
export { default as BackupManagerService } from "./modules/backup-manager/service"
