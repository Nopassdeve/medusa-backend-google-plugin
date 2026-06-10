import { Module } from "@medusajs/framework/utils"
import BackupManagerService from "./service"

export const BACKUP_MANAGER_MODULE = "backupManager"

export default Module(BACKUP_MANAGER_MODULE, {
  service: BackupManagerService,
})
