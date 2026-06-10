import { defineRouteConfig } from "@medusajs/admin-sdk"
import { CloudArrowUp, CogSixTooth } from "@medusajs/icons"
import { Container, Heading, Text, Button, toast, Toaster, Input, Label, Select, Table, Badge, Code, ProgressTabs } from "@medusajs/ui"
import { useState, useEffect, useCallback } from "react"

interface BackupRecord {
  id: string; fileName: string; googleDriveFileId: string; size: number
  type: "scheduled" | "manual" | "pre-deploy"
  status: "success" | "failed" | "in-progress"
  createdAt: string; completedAt?: string; errorMessage?: string
}
interface BackupStats {
  totalBackups: number; lastBackupAt: string | null
  nextBackupAt: string | null; totalSize: number; backups: BackupRecord[]
}
interface BackupConfig {
  googleDriveFolderId: string
  googleServiceAccountKey?: string
  googleOauthClientId?: string
  googleOauthClientSecret?: string
  googleOauthRefreshToken?: string
  databaseUrl: string; cronExpression: string; retentionDays: number
  githubRepoUrl: string; githubToken: string
}

function fmtBytes(b: number): string {
  if (!b) return "0 B"
  const u = ["B", "KB", "MB", "GB"], i = Math.floor(Math.log(b) / Math.log(1024))
  return parseFloat((b / Math.pow(1024, i)).toFixed(2)) + " " + u[i]
}
function fmtDate(d: string | null): string { return d ? new Date(d).toLocaleString("zh-CN") : "暂无" }

const StatBadge = ({ s }: { s: BackupRecord["status"] }) => (
  <Badge color={s === "success" ? "green" : s === "failed" ? "red" : "orange"}>
    {s === "success" ? "成功" : s === "failed" ? "失败" : "进行中"}
  </Badge>
)
const TypeBadge = ({ t }: { t: BackupRecord["type"] }) => (
  <Badge>{t === "scheduled" ? "定时" : t === "manual" ? "手动" : "部署前"}</Badge>
)

// Use window.__sdk (set by Medusa dashboard at startup) for authenticated fetch.
// Falls back to credentials:include for same-origin setups.
const sdkFetch = async <T = any>(path: string, options?: { method?: string; body?: any }): Promise<T> => {
  const sdk = (typeof window !== "undefined" ? (window as any).__sdk : null) as
    | { client: { fetch: <R>(p: string, i?: any) => Promise<R> } }
    | null
  if (sdk?.client?.fetch) {
    // SDK expects body as object (it will JSON.stringify internally)
    return sdk.client.fetch<T>(path, {
      method: options?.method || "GET",
      headers: options?.body ? { "Content-Type": "application/json" } : undefined,
      body: options?.body,
    })
  }
  // Fallback for same-origin / dev
  const res = await fetch(path, {
    method: options?.method || "GET",
    credentials: "include",
    headers: options?.body ? { "Content-Type": "application/json" } : undefined,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || err.error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export default function BackupDashboardPage() {
  const [stats, setStats] = useState<BackupStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [folderId, setFolderId] = useState("")
  const [oauthClientId, setOauthClientId] = useState("")
  const [oauthClientSecret, setOauthClientSecret] = useState("")
  const [oauthRefreshToken, setOauthRefreshToken] = useState("")
  const [dbUrl, setDbUrl] = useState("")
  const [cron, setCron] = useState("0 3 * * *")
  const [retention, setRetention] = useState(7)
  const [ghRepo, setGhRepo] = useState("")
  const [ghToken, setGhToken] = useState("")
  const [errorMsg, setErrorMsg] = useState("")
  const [editingFolder, setEditingFolder] = useState(false)
  const [editingOauth, setEditingOauth] = useState(false)
  const [editingGhToken, setEditingGhToken] = useState(false)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    try {
      setErrorMsg("")
      const d = await sdkFetch<any>("/admin/backups")
      if (d.stats) setStats(d.stats)
      if (!dbUrl && d.env?.databaseUrl) setDbUrl(d.env.databaseUrl)
      if (d.config) {
        const c = d.config
        setFolderId(c.googleDriveFolderId || "")
        setOauthClientId(c.googleOauthClientId || "")
        setOauthClientSecret(c.googleOauthClientSecret || "")
        setOauthRefreshToken(c.googleOauthRefreshToken || "")
        setDbUrl(c.databaseUrl || d.env?.databaseUrl || "")
        setCron(c.cronExpression || "0 3 * * *")
        setRetention(c.retentionDays || 7)
        setGhRepo(c.githubRepoUrl || "")
        setGhToken(c.githubToken || "")
        if (c.googleDriveFolderId || c.googleOauthClientId || c.googleOauthRefreshToken || c.githubToken) setSaved(true)
      }
    } catch(e: any) { setErrorMsg(e.message) }
  }, [])
  useEffect(() => { load() }, [load])

  const api = async (action: string, body?: any) => {
    setErrorMsg("")
    try {
      const result = await sdkFetch<any>("/admin/backups", {
        method: "POST",
        body: { action, ...body },
      })
      if (result?.error) {
        const detail = result.stack ? `${result.error}\n${result.stack}` : result.error
        setErrorMsg(detail)
        console.error("[BackupPlugin] API error:", detail)
      }
      return result
    } catch(e: any) {
      const detail = e?.message || "请求失败"
      setErrorMsg(detail)
      return { error: detail }
    }
  }

  const requestRefreshToken = async () => {
    if (!oauthClientId || !oauthClientSecret) {
      toast.error("请先填写 Client ID 和 Client Secret")
      return
    }

    const res = await sdkFetch<{ authUrl?: string; redirectUri?: string; error?: string }>("/admin/generate-auth-url", {
      method: "POST",
      body: {
        clientId: oauthClientId,
        clientSecret: oauthClientSecret,
      },
    })

    if (res.authUrl) {
      // Show the exact redirectUri so user can verify it matches Google Console
      if (res.redirectUri) {
        console.log("[BackupPlugin] OAuth redirectUri:", res.redirectUri)
        toast.success("重定向 URI: " + res.redirectUri + "（请确保此 URI 已在 Google Console 注册）", { duration: 8000 } as any)
      }
      setTimeout(() => window.open(res.authUrl, "_blank"), 800)
      return
    }

    toast.error("生成授权链接失败: " + (res.error || "未知错误"))
  }

  return (
    <Container>
      <Toaster />
      <div style={{ padding: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
          <div>
            <Heading level="h1">🛡️ 备份与部署中心</Heading>
            <Text>Google Drive 自动备份 · 一键恢复 · 多店铺同步部署</Text>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button variant="secondary" disabled={loading} onClick={async () => {
              const d = await api("test-drive"); d?.connected ? toast.success("✅ "+d.message) : toast.error("❌ "+(d?.message||"连接失败"))
            }}>🔗 测试连接</Button>
            <Button disabled={loading} onClick={async () => {
              setLoading(true); try { const d = await api("backup"); d?.success ? toast.success("✅ 备份成功") : toast.error(d?.error || "备份失败"); load() } catch(e:any){toast.error(e.message)} finally { setLoading(false) }
            }}><CloudArrowUp /> 立即备份</Button>
          </div>
        </div>

        {errorMsg && <div style={{ padding: 12, marginBottom: 16, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, color: "#dc2626" }}>
          <Text size="small" style={{ fontWeight: 600 }}>❌ {errorMsg}</Text>
        </div>}

        {stats && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 24 }}>
            {[["备份总数", stats.totalBackups],["最近备份", fmtDate(stats.lastBackupAt)],["下次备份", fmtDate(stats.nextBackupAt)],["云端占用", fmtBytes(stats.totalSize)]].map(([l,v]) => (
              <div key={l as string} style={{ padding: 16, border: "1px solid #e5e7eb", borderRadius: 8, background: "#f9fafb" }}>
                <Text size="small" style={{ color: "#6b7280" }}>{l as string}</Text>
                <Text size="large" style={{ fontWeight: 600, marginTop: 4 }}>{String(v)}</Text>
              </div>
            ))}
          </div>
        )}

        <ProgressTabs defaultValue="backups">
          <ProgressTabs.List>
            <ProgressTabs.Trigger value="backups">📋 备份记录</ProgressTabs.Trigger>
            <ProgressTabs.Trigger value="tutorial">📖 配置教程</ProgressTabs.Trigger>
            <ProgressTabs.Trigger value="settings">⚙️ 设置</ProgressTabs.Trigger>
            <ProgressTabs.Trigger value="deploy">🚀 部署</ProgressTabs.Trigger>
          </ProgressTabs.List>

          {/* 备份记录 */}
          <ProgressTabs.Content value="backups">
            <div style={{ marginTop: 16 }}>
              {(stats?.backups||[]).length===0 ? (
                <div style={{ textAlign: "center", padding: 48, color: "#9ca3af" }}>
                  <Text size="large">📭 暂无备份记录</Text>
                  <Text size="small" style={{ marginTop: 8 }}>请先在「配置教程」完成 Google Drive 设置，然后点击「立即备份」</Text>
                </div>
              ) : (
                <Table>
                  <Table.Header><Table.Row>
                    {["文件名","类型","大小","状态","创建时间","操作"].map(h=><Table.HeaderCell key={h}>{h}</Table.HeaderCell>)}
                  </Table.Row></Table.Header>
                  <Table.Body>
                    {(stats?.backups||[]).map(b=><Table.Row key={b.id}>
                      <Table.Cell><Code>{b.fileName}</Code></Table.Cell>
                      <Table.Cell><TypeBadge t={b.type} /></Table.Cell>
                      <Table.Cell>{fmtBytes(b.size)}</Table.Cell>
                      <Table.Cell><StatBadge s={b.status} /></Table.Cell>
                      <Table.Cell>{fmtDate(b.createdAt)}</Table.Cell>
                      <Table.Cell>
                        <Button variant="secondary" size="small" disabled={restoring===b.id||b.status!=="success"}
                          onClick={async()=>{setRestoring(b.id);try{const d=await api("restore",{backupId:b.id});d.success?toast.success("✅ 恢复完成"):toast.error("失败:"+d.message)}catch(e:any){toast.error(e.message)}finally{setRestoring(null)}}}>
                          {restoring===b.id?"恢复中...":"🔄 恢复"}
                        </Button>
                      </Table.Cell>
                    </Table.Row>)}
                  </Table.Body>
                </Table>
              )}
            </div>
          </ProgressTabs.Content>

          {/* 配置教程 */}
          <ProgressTabs.Content value="tutorial">
            <div style={{ marginTop: 16, maxWidth: 800 }}>
              <Heading level="h2" style={{ marginBottom: 16 }}>📖 快速配置教程</Heading>
              <div style={{ padding: 16, border: "1px solid #e5e7eb", borderRadius: 8, marginBottom: 16 }}>
                <Heading level="h3" style={{ marginBottom: 12 }}>第一步：创建 Google OAuth 应用</Heading>
                <ol style={{ paddingLeft: 20, lineHeight: 2.2 }}>
                  <li>打开 <a href="https://console.cloud.google.com/" target="_blank" style={{ color: "#2563eb" }}>Google Cloud Console</a>，创建/选择项目</li>
                  <li>API 和服务 → 库 → 搜索 <strong>Google Drive API</strong> → 启用</li>
                  <li>API 和服务 → 凭据 → 创建凭据 → <strong>OAuth 客户端 ID</strong></li>
                  <li>应用类型可选 Web application 或 Desktop app</li>
                  <li>复制生成的 <strong>Client ID</strong> 和 <strong>Client Secret</strong></li>
                  <li>再通过 OAuth 授权流程拿到 <strong>Refresh Token</strong>，填到「设置」里</li>
                </ol>
              </div>
              <div style={{ padding: 16, border: "1px solid #e5e7eb", borderRadius: 8, marginBottom: 16 }}>
                <Heading level="h3" style={{ marginBottom: 12 }}>第二步：创建 Google Drive 备份文件夹</Heading>
                <ol style={{ paddingLeft: 20, lineHeight: 2.2 }}>
                  <li>打开 <a href="https://drive.google.com/" target="_blank" style={{ color: "#2563eb" }}>Google Drive</a>，新建文件夹「Lurpes 备份」</li>
                  <li>如果你使用的是普通 My Drive，OAuth 授权用户本身必须能访问这个文件夹</li>
                  <li>如果你使用 Shared Drive，授权用户也必须有写入权限</li>
                  <li>打开文件夹，浏览器地址栏 <Code>folders/</Code> 后面的字符串就是文件夹 ID</li>
                  <li>复制到「设置 → Google Drive 文件夹 ID」</li>
                </ol>
              </div>
              <div style={{ padding: 16, border: "1px solid #e5e7eb", borderRadius: 8, marginBottom: 16 }}>
                <Heading level="h3" style={{ marginBottom: 12 }}>第三步：设置备份频率</Heading>
                <Text style={{ lineHeight: 1.8 }}>
                  在设置中通过下拉菜单选择备份频率，无需手动编写 Cron 表达式：
                </Text>
                <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
                  <Text size="small">📅 <strong>每天</strong> — 每日定时备份（推荐）</Text>
                  <Text size="small">⏱️ <strong>每 6 小时</strong> — 每天 4 次备份</Text>
                  <Text size="small">📆 <strong>每周日</strong> — 每周备份一次</Text>
                </div>
                <Text size="small" style={{ color: "#6b7280", marginTop: 8 }}>
                  配合 <strong>保留天数</strong>（推荐 7 天），旧备份会自动从 Google Drive 清理。
                </Text>
              </div>
            </div>
          </ProgressTabs.Content>

          {/* 设置 */}
          <ProgressTabs.Content value="settings">
            <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 16, maxWidth: 640 }}>
              <div>
                <Label>📁 Google Drive 文件夹 ID</Label>
                {saved && folderId && !editingFolder ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <Input value={"•".repeat(24) + folderId.slice(-4)} readOnly style={{ flex: 1, color: "#6b7280" }} />
                    <Button variant="secondary" size="small" onClick={() => setEditingFolder(true)}>✏️ 修改</Button>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8 }}>
                    <Input placeholder="1a2b3c4d5e6f..." value={folderId} onChange={(e:any)=>setFolderId(e.target.value)} style={{ flex: 1 }} />
                    {saved && <Button variant="secondary" size="small" onClick={() => setEditingFolder(false)}>取消</Button>}
                  </div>
                )}
                <Text size="xsmall" style={{ color: "#6b7280" }}>打开 Google Drive 文件夹，URL 中 folders/ 后面的字符串</Text>
              </div>
              <div>
                <Label>🔑 Google OAuth 凭据</Label>
                {saved && (oauthClientId || oauthClientSecret || oauthRefreshToken) && !editingOauth ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <div style={{ flex: 1, display: "grid", gap: 8 }}>
                      <Input value={(oauthClientId ? oauthClientId.slice(0, 18) : "") + "..."} readOnly style={{ color: "#6b7280" }} />
                      <Input value={oauthClientSecret ? "•".repeat(24) + oauthClientSecret.slice(-4) : ""} readOnly style={{ color: "#6b7280" }} />
                      <Input value={oauthRefreshToken ? "•".repeat(24) + oauthRefreshToken.slice(-6) : ""} readOnly style={{ color: "#6b7280" }} />
                    </div>
                    <div style={{ display: "grid", gap: 8 }}>
                      <Button variant="secondary" size="small" onClick={() => setEditingOauth(true)}>✏️ 修改</Button>
                      <Button variant="secondary" size="small" onClick={requestRefreshToken}>获取 Token</Button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "grid", gap: 8 }}>
                    <Input placeholder="OAuth Client ID" value={oauthClientId} onChange={(e:any)=>setOauthClientId(e.target.value)} />
                    <Input placeholder="OAuth Client Secret" value={oauthClientSecret} onChange={(e:any)=>setOauthClientSecret(e.target.value)} />
                    <Input placeholder="OAuth Refresh Token" value={oauthRefreshToken} onChange={(e:any)=>setOauthRefreshToken(e.target.value)} style={{ flex: 1 }} />
                    <Button variant="secondary" size="small" onClick={requestRefreshToken}>获取 Token</Button>
                    {saved && <div><Button variant="secondary" size="small" onClick={() => setEditingOauth(false)}>取消</Button></div>}
                  </div>
                )}
                <Text size="xsmall" style={{ color: "#6b7280" }}>请填写 Google OAuth 的 Client ID、Client Secret 和 Refresh Token，用于写入普通 My Drive。</Text>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div>
                  <Label>⏰ 备份频率</Label>
                  <Select value={cron.startsWith("0 */") ? "hours" : cron.startsWith("0 0 * * 0") ? "weekly" : "daily"} onValueChange={(v) => {
                    if (v === "daily") setCron("0 3 * * *")
                    else if (v === "hours") setCron("0 */6 * * *")
                    else setCron("0 0 * * 0")
                  }}>
                    <Select.Trigger><Select.Value /></Select.Trigger>
                    <Select.Content>
                      <Select.Item value="daily">每天</Select.Item>
                      <Select.Item value="hours">每 6 小时</Select.Item>
                      <Select.Item value="weekly">每周日</Select.Item>
                    </Select.Content>
                  </Select>
                </div>
                <div>
                  <Label>🕐 备份时间（每天模式）</Label>
                  <Select value={cron.match(/^0 (\d+) /)?.[1] || "3"} onValueChange={(v) => setCron(`0 ${v} * * *`)}>
                    <Select.Trigger><Select.Value /></Select.Trigger>
                    <Select.Content>
                      {["0","1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23"].map(h => (
                        <Select.Item key={h} value={h}>{h}:00</Select.Item>
                      ))}
                    </Select.Content>
                  </Select>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div>
                  <Label>📅 保留天数</Label>
                  <Select value={String(retention)} onValueChange={v=>setRetention(Number(v))}>
                    <Select.Trigger><Select.Value /></Select.Trigger>
                    <Select.Content>{[3,5,7,10,14,30].map(d=><Select.Item key={d} value={String(d)}>{d} 天</Select.Item>)}</Select.Content>
                  </Select>
                  <Text size="xsmall" style={{ color: "#6b7280" }}>自动删除超过此天数的旧备份</Text>
                </div>
                <div />
              </div>
              <div>
                <Label>🐙 GitHub Token（用于自动注册 Webhook）</Label>
                {saved && ghToken && !editingGhToken ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <Input value={"ghp_" + "•".repeat(16) + ghToken.slice(-4)} readOnly style={{ flex: 1, color: "#6b7280" }} />
                    <Button variant="secondary" size="small" onClick={() => setEditingGhToken(true)}>✏️ 修改</Button>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8 }}>
                    <Input placeholder="ghp_xxxxxxxxxxxx" value={ghToken} onChange={(e:any)=>setGhToken(e.target.value)} style={{ flex: 1 }} />
                    {saved && <Button variant="secondary" size="small" onClick={() => setEditingGhToken(false)}>取消</Button>}
                  </div>
                )}
                <Text size="xsmall" style={{ color: "#6b7280" }}>
                  需要 <Code>admin:repo_hook</Code> 权限。在 <a href="https://github.com/settings/tokens" target="_blank">github.com/settings/tokens</a> 生成
                </Text>
              </div>
              <div>
                <Label>🐙 GitHub 仓库地址（含 .git）</Label>
                <Input placeholder="git@github.com:用户名/仓库名.git" value={ghRepo} onChange={(e:any)=>setGhRepo(e.target.value)} />
              </div>
              <Button disabled={loading} onClick={async()=>{
                setLoading(true)
                try {
                  const d = await api("configure", { config: { googleDriveFolderId: folderId, googleOauthClientId: oauthClientId, googleOauthClientSecret: oauthClientSecret, googleOauthRefreshToken: oauthRefreshToken, databaseUrl: dbUrl, cronExpression: cron, retentionDays: retention, githubRepoUrl: ghRepo, githubToken: ghToken } })
                  if (d?.success) {
                    toast.success("✅ 已保存，定时备份已启动")
                    setSaved(true)
                    setEditingFolder(false); setEditingOauth(false); setEditingGhToken(false)
                  } else {
                    toast.error("失败：" + (d?.error || ""))
                  }
                  load()
                } catch(e:any){toast.error(e.message)} finally{setLoading(false)}
              }}><CogSixTooth /> {loading ? "保存中..." : "💾 保存并启动定时备份"}</Button>
            </div>
          </ProgressTabs.Content>

          {/* 部署 */}
          <ProgressTabs.Content value="deploy">
            <div style={{ marginTop: 16, maxWidth: 800 }}>
              <Heading level="h2" style={{ marginBottom: 12 }}>🚀 多店铺自动部署</Heading>

              <div style={{ padding: 16, border: "1px solid #2563eb", borderRadius: 8, marginBottom: 16, background: "#eff6ff" }}>
                <Heading level="h3" style={{ marginBottom: 8, color: "#1d4ed8" }}>💡 全自动！无需手动配置</Heading>
                <Text style={{ lineHeight: 1.8 }}>
                  插件安装后，自动通过 <strong>GitHub API</strong> 将当前店铺的 Webhook 注册到你的 GitHub 仓库。<br />
                  你只需要 <Code>git push</Code>，所有店铺 <strong>自动拉取更新并重启</strong>。<br />
                  <strong>不需要登录任何店铺后台手动操作！</strong>
                </Text>
              </div>

              <div style={{ padding: 16, border: "1px solid #e5e7eb", borderRadius: 8, marginBottom: 16 }}>
                <Heading level="h3" style={{ marginBottom: 12 }}>🔧 唯一需要做的事：配置 GitHub Token</Heading>
                <Text style={{ lineHeight: 1.8, marginBottom: 12 }}>
                  插件需要一个 GitHub Personal Access Token 来自动注册 Webhook。<br />
                  每个店铺启动时自动调用 GitHub API 添加自己的 Webhook URL。
                </Text>
                <ol style={{ paddingLeft: 20, lineHeight: 2.2 }}>
                  <li>打开 <a href="https://github.com/settings/tokens" target="_blank" style={{ color: "#2563eb" }}>GitHub Token 设置</a></li>
                  <li>点击 <strong>Generate new token (classic)</strong></li>
                  <li>勾选权限：<Code>admin:repo_hook</Code>（管理 Webhook）</li>
                  <li>生成后复制 token，粘贴到下方</li>
                </ol>
              </div>

              <div style={{ padding: 16, border: "1px solid #10b981", borderRadius: 8, marginBottom: 16, background: "#f0fdf4" }}>
                <Heading level="h3" style={{ marginBottom: 12, color: "#065f46" }}>🔄 自动工作流程</Heading>
                <Text size="small" style={{ lineHeight: 2.2, fontFamily: "monospace" }}>
                  ① 安装插件到店铺 A、B、C<br />
                  ② 每个店铺启动时 → 自动调 GitHub API 注册 Webhook<br />
                  ③ 你本地 git push 到 GitHub<br />
                  ④ GitHub 自动通知所有店铺<br />
                  ⑤ 每个店铺自动 git pull + npm install + 重启<br />
                  ⑥ ✅ 全部更新完成，无需人工干预！
                </Text>
              </div>

              <div style={{ padding: 16, border: "1px solid #e5e7eb", borderRadius: 8, marginBottom: 16, background: "#f9fafb" }}>
                <Heading level="h3" style={{ marginBottom: 8 }}>📝 当前店铺注册信息</Heading>
                <div style={{ display: "grid", gap: 8 }}>
                  <div><Text size="small" style={{ color: "#6b7280" }}>Webhook URL（自动注册）</Text>
                    <Code style={{ fontSize: 13 }}>{typeof window !== "undefined" ? `${window.location.protocol}//${window.location.host}/store/deploy` : "..."}</Code>
                  </div>
                  <div><Text size="small" style={{ color: "#6b7280" }}>GitHub 仓库</Text>
                    <Code style={{ fontSize: 13 }}>{ghRepo || "未配置"}</Code>
                  </div>
                </div>
              </div>
            </div>
          </ProgressTabs.Content>
        </ProgressTabs>
      </div>
    </Container>
  )
}

export const config = defineRouteConfig({ label: "备份与部署", icon: CloudArrowUp })
