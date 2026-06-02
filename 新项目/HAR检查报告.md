# NovelAI 生成请求 HAR 检查报告

## 文件整理

仓库根目录下的 HAR 文件已移动到 `新项目/` 文件夹，包含：

- `GET-subscription.cleaned.har`
- `GET-updateReload.cleaned.har`
- `GET_trial-status.cleaned.har`
- `OPTION- generate-image steam.cleaned.har`
- `OPTION-subscription.cleaned.har`
- `OPTION_trial-status.cleaned.har`
- `POST- generate-image steam.cleaned.har`

## 检查结论

1. 这些 HAR 中没有发现响应或请求字段名直接叫 `anlas` / `Anlas` 的内容。
2. 生成动作的核心请求是 `POST https://image.novelai.net/ai/generate-image-stream` 或 `POST https://image.novelai.net/ai/generate-image`，请求体包含 prompt、model、width、height、steps、sampler、seed、image_format 等生成参数，但没有发现本次消耗 Anlas 的字段。
3. 与用量最接近的接口是：
   - `GET https://api.novelai.net/user/subscription`
   - `GET https://text.novelai.net/ai/trial-status`
4. `subscription` 响应显示账号为 Opus 订阅，`perks.unlimitedImageGeneration` 为 `true`，并带有 `unlimitedImageGenerationLimits`。这能解释页面上本次生成显示 Anlas 消耗为 `0` 的情况，但该响应本身不是“本次生成消耗多少 Anlas”的封包。
5. `trial-status` 响应包含 `used_image_actions` 与 `remaining_image_actions`，但它是 trial actions 状态，不是 Anlas 单次扣费字段。

## 关键接口摘要

| HAR 文件 | 生成接口 | 订阅/试用状态接口中的相关内容 |
| --- | --- | --- |
| `GET-subscription.cleaned.har` | `POST /ai/generate-image-stream` | `unlimitedImageGeneration: true`; `used_image_actions: 0`; `remaining_image_actions: 30` |
| `GET-updateReload.cleaned.har` | `POST /ai/generate-image` | `unlimitedImageGeneration: true`; `used_image_actions: 0`; `remaining_image_actions: 30` |
| `GET_trial-status.cleaned.har` | `POST /ai/generate-image-stream` | `unlimitedImageGeneration: true`; `used_image_actions: 0`; `remaining_image_actions: 30` |
| `OPTION- generate-image steam.cleaned.har` | `POST /ai/generate-image-stream` | `unlimitedImageGeneration: true`; `used_image_actions: 0`; `remaining_image_actions: 30` |
| `OPTION-subscription.cleaned.har` | `POST /ai/generate-image-stream` | `unlimitedImageGeneration: true`; `used_image_actions: 0`; `remaining_image_actions: 30` |
| `OPTION_trial-status.cleaned.har` | `POST /ai/generate-image-stream` | `unlimitedImageGeneration: true`; `used_image_actions: 0`; `remaining_image_actions: 30` |
| `POST- generate-image steam.cleaned.har` | `POST /ai/generate-image-stream` | `unlimitedImageGeneration: true`; `used_image_actions: 0`; `remaining_image_actions: 30` |

## 对脚本实现的影响

因为 HAR 里没有稳定的“本次 Anlas 消耗”封包字段，新脚本采用前端 DOM 读取策略：在用户点击 NovelAI 的 `Generate` 按钮时，从页面当前显示的 Anlas 数字读取消耗值，再和自定义阈值比较。
