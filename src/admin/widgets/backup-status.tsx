import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Container, Heading, Text, Badge } from "@medusajs/ui"
import { useEffect, useState } from "react"

const getAuthToken = (): string | null => {
  if (typeof window === "undefined") return null
  return (
    localStorage.getItem("medusa_auth_token") ||
    localStorage.getItem("medusa_admin_auth_token") ||
    localStorage.getItem("access_token") ||
    localStorage.getItem("jwt") ||
    localStorage.getItem("token")
  )
}

const BackupStatusWidget = () => {
  const [status, setStatus] = useState<{ lastBackup: string | null; totalBackups: number }>({
    lastBackup: null,
    totalBackups: 0,
  })

  useEffect(() => {
    const token = getAuthToken()
    if (!token) return

    fetch("/admin/backups", {
      headers: { Authorization: `Bearer ${token}`, "x-medusa-access-token": token },
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.stats) {
          setStatus({
            lastBackup: data.stats.lastBackupAt,
            totalBackups: data.stats.totalBackups,
          })
        }
      })
      .catch(() => {})
  }, [])

  return (
    <Container>
      <Heading level="h2">Backup Status</Heading>
      <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <Text size="small">Total Backups</Text>
          <Badge>{status.totalBackups}</Badge>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <Text size="small">Last Backup</Text>
          <Text size="small">
            {status.lastBackup ? new Date(status.lastBackup).toLocaleString() : "Never"}
          </Text>
        </div>
      </div>
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.after",
})

export default BackupStatusWidget
