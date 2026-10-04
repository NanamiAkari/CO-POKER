# CO-POKER 版本与发布流程

开发分支是 `main`。普通提交、Pull Request 和 CI 只运行测试，不连接服务器。服务器只接受 GitHub 的版本标签发布，避免开发中的半成品进入线上。

## 本地开发

```powershell
npm ci
npm test
npm start
```

完成一个可发布版本后提交并推送：

```powershell
git add .
git commit -m "feat: describe the completed change"
git push origin main
```

## 发布线上

发布前确认本地测试、浏览器验收和发布说明都完成，然后创建语义化版本标签：

```powershell
git tag -a v0.2.0 -m "CO-POKER v0.2.0"
git push origin v0.2.0
```

推送 `v*.*.*` 标签会触发 `.github/workflows/release.yml`：

1. 从该标签检出代码。
2. 执行 `npm ci` 和完整 `npm test`。
3. 打包 `public/`、`src/`、依赖清单和 PM2 配置。
4. 通过 GitHub Actions 的生产环境密钥连接阿里云服务器。
5. 在服务器保存带版本号的备份，安装发布包，安装生产依赖，重启 PM2 并检查 `/health`。
6. 任一步失败则保留备份并让工作流失败，方便回滚。

开发提交不会触发发布工作流。GitHub Actions 的 `production` environment 需要配置：

| Secret | 内容 |
| --- | --- |
| `PROD_HOST` | `101.132.136.52` |
| `PROD_PORT` | `22` |
| `PROD_USER` | `root` 或单独的部署用户 |
| `PROD_SSH_KEY` | 仅用于 GitHub Actions 的部署私钥，多行原文 |

建议为部署单独创建 SSH 密钥和服务器用户，限制其只能更新 `/opt/cooperative-poker`、执行 PM2 和检查健康接口。服务器现有运行版本不会因为开发提交改变。

## 回滚

每次发布在服务器 `/opt/cooperative-poker/.deploy/releases/<tag>-<sha>/backup` 保存当前 `src/` 和 `public/`。发布失败会自动尝试恢复备份。需要手动回滚时，优先再次发布上一个已验证标签，不要直接在服务器编辑业务文件。

## 服务器原则

服务器不从 `main` 拉取开发代码，也不保存 GitHub token。服务器只接收 GitHub Actions 针对版本标签生成的发布包。生产数据、账号数据和未来的数据库迁移必须单独备份，不能依赖 Git 仓库。
