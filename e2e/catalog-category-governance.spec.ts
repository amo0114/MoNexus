import { expect, test, type Locator, type Page } from '@playwright/test'
import { SEED_ACCOUNTS, loginAs } from './helpers'

/**
 * PAR-CMI-002 — Catalog category governance（create + pending duplicate + withdraw + admin create_new/map_existing/reject review + withdraw vs stale review race + admin repository create/edit/deactivate）。
 *
 * 已覆盖（REQ-CAT-F-008 / D-CAT-10 / AC-CAT-012 / CHK-CAT-008）：
 * 1. 商家真实登录 → /merchant → 点击「分类申请」→ 面板 category-application-panel 出现；
 * 2. 打开申请表 → 填 unique LABEL / CODE、≥20 字描述、示例商品；
 * 3. 点击真实提交动作前监听「精确 pathname /api/merchant/category-applications 且 POST」；
 * 4. 断言响应 201（server applicationRoutes.test.ts 真实契约：POST create → 201），
 *    用类型守卫从 unknown JSON 安全取得正整数 applicationId，并断言
 *    proposedLabel===LABEL、proposedCode===CODE、status==='pending'，保存 id；
 * 5. 请求 JSON 精确四 allowlist 字段（proposedLabel/proposedCode/description/
 *    exampleProducts），且明确无 merchantId/status（归属服务端从 auth 派生）；
 * 6. toast「分类申请已提交，等待平台审核」；列表行 application-row-<id>
 *    data-status=pending。
 *
 * duplicate（409 CATEGORY_APPLICATION_PENDING_DUPLICATE）：同一商家对同一
 * normalizedLabel 的 pending 申请重复提交 → 409 + 稳定错误码；UI 按码取词显示
 * 「你已有一个相同名称的分类申请在审核中」，表单保持打开、submit 恢复可重试，
 * 且全程不出现成功 toast。
 *
 * withdraw（D-CAT-10 / AC-CAT-012）：对同一 pending 申请点击 application-withdraw-<id>
 * → 确认 dialog → 在 dialog 范围内点「撤回」确认按钮 → 监听精确 POST
 * /api/merchant/category-applications/<id>/withdraw → 断言 200；严格类型守卫从
 * unknown JSON 证明 id===applicationId 且 status==='withdrawn'；toast「申请已撤回」；
 * 列表自行刷新（禁止 page.reload）后同一行 data-status=withdrawn、
 * application-withdraw-<id> 消失。
 *
 * 额外 pending 数据准备：为后续管理员审核准备一条全新 pending 申请——独立
 * loginAs → /merchant → 分类申请 → 真实表单，填唯一 ADMIN_REVIEW_LABEL /
 * 合法 lower-case ADMIN_REVIEW_CODE / ≥20 字 ADMIN_REVIEW_DESCRIPTION；点击前
 * 监听精确 POST /api/merchant/category-applications 断言 201；严格类型守卫从
 * unknown JSON 解析正整数 adminReviewApplicationId，label/code/status 精确匹配；
 * 请求体精确四 allowlist 且无 merchantId/status；toast 成功 + application-row-
 * <adminReviewApplicationId> data-status=pending；绝不 withdraw（供后续 admin 审核）。
 *
 * admin create_new 审核（D-CAT-11 / AC-CAT-013）：真实 admin MFA loginAs → /admin →
 * 「目录治理」→ admin-category-manager；默认 pending 筛选下按 application-row-
 * <adminReviewApplicationId> 精准定位，点击 application-approve-new-<id> 打开
 * create_new review dialog；核对 code/label/description 预填为 ADMIN_REVIEW_*，
 * 填 review-icon='folder-tree' + 常量 ADMIN_REVIEW_REASON；点击前监听精确 POST
 * /api/admin/category-applications/<id>/approve 断言 200；严格类型守卫从 unknown
 * JSON 证明 id 相同、status='approved'、resolution='create_new'、approvedCategoryId
 * 正整数、reviewReason 精确，且响应键命中冻结 DTO allowlist（拒绝任何额外键、
 * 显式点名内部/操作者字段，merchantId 为合法公开字段），保存 approvedCategoryId；
 * 请求体精确 {resolution, category, reviewReason} 键集合且无 reviewer/user/admin
 * ID；toast「已通过并新建分类」
 * + dialog 关闭；pending 列表刷新后 row 消失；切 admin-application-status-filter=
 * approved 回查同 row data-status=approved、resolution「新建分类」并含 #approvedCategoryId。
 *
 * map_existing 数据准备（第 6 个用例，纯 merchant 侧，不做 admin）：独立 loginAs →
 * /merchant → 分类申请 → 真实表单，填唯一 MAP_REVIEW_LABEL / 合法 lower-case
 * MAP_REVIEW_CODE / ≥20 字 MAP_REVIEW_DESCRIPTION；点击前监听精确 POST
 * /api/merchant/category-applications 断言 201；复用 parseApplication(expected) 严格
 * 解析正整数 mapReviewApplicationId，label/code/status 精确匹配；请求体精确四
 * allowlist 且无 merchantId/status；toast 成功 + application-row-<mapReviewApplicationId>
 * data-status=pending；绝不 withdraw。该 pending 将在后续映射到前一 create_new 已
 * 生成的 approvedCategoryId（map 审核留后续）。
 *
 * admin map_existing 审核（D-CAT-10 / D-CAT-11 / AC-CAT-014）：真实 admin MFA loginAs → /admin →
 * 「目录治理」→ admin-category-manager；默认 pending 筛选下按 application-row-
 * <mapReviewApplicationId> 精准定位，点击 application-approve-map-<id> 打开 map_existing
 * review dialog；核对模式标题 + 申请名称，在 review-category 下拉选择
 * String(approvedCategoryId)——既有 create_new 分类为 active，组件以 GET
 * /api/admin/product-categories?status=active&pageSize=100 加载该下拉；再填常量
 * MAP_REVIEW_REASON；点击前监听精确 POST /api/admin/category-applications/<id>/approve
 * 断言 200；严格类型守卫从 unknown JSON 证明 id 相同、status='approved'、
 * resolution='map_existing'、approvedCategoryId 精确等于既有值、reviewReason 精确，
 * 且响应键命中冻结 DTO allowlist（拒绝额外键、点名内部/操作者字段）；请求体精确
 * { resolution, categoryId, reviewReason } 三键且无 category 块/操作者 ID；
 * toast「已通过并映射到现有分类」+ dialog 关闭；pending row 消失；切 approved 回查
 * data-status=approved、resolution「映射现有分类」并含 #approvedCategoryId。
 * 分类仓库 total 以真实 read network 在审核前/审核后各解析一次并严格断言不变，证明
 * map_existing 不新建分类；绝不断言 MAP_REVIEW_CODE 分类存在（它不应被创建）。
 * reject 数据准备（第 8 个用例，纯 merchant 侧，不做 admin）：独立 loginAs →
 * /merchant → 分类申请 → 真实表单，填唯一 REJECT_REVIEW_LABEL / 合法 lower-case
 * REJECT_REVIEW_CODE / ≥20 字 REJECT_REVIEW_DESCRIPTION；点击前监听精确 POST
 * /api/merchant/category-applications 断言 201；复用 parseApplication(expected) 严格
 * 解析正整数 rejectReviewApplicationId，label/code/status 精确匹配；请求体精确四
 * allowlist 且无 merchantId/status；toast 成功 + application-row-<rejectReviewApplicationId>
 * data-status=pending；绝不 withdraw（供后续 admin reject 审核）。
 *
 * admin reject（D-CAT-10 / D-CAT-11 / REQ-CAT-F-008 / CHK-CAT-008）：真实 admin MFA
 * loginAs → /admin → 「目录治理」→ admin-category-manager；默认 pending 筛选下按
 * application-row-<rejectReviewApplicationId> 精准定位，点击 application-reject-<id>
 * 打开 reject review dialog；断言标题「拒绝申请」+ 申请名称；reason 留空点击
 * review-submit → 必须断言「审核理由不能为空」且 dialog 保持，并用 page request
 * 计数仅统计精确 pathname+POST 证明未发出该 id 的 reject 请求（计数为 0）；填常量
 * REJECT_REVIEW_REASON；点击前监听精确 POST /api/admin/category-applications/<id>/reject
 * 断言 200；严格类型守卫从 unknown JSON 证明 id 相同、status='rejected'、
 * resolution===null、approvedCategoryId===null、reviewReason 精确，且响应键命中冻结
 * DTO allowlist（拒绝额外键、点名内部/操作者字段）；请求体类型守卫验证精确一键
 * { reviewReason }，拒绝任何额外键（含 reviewer/user/admin 操作者 ID）；toast
 * 「已拒绝该申请」+ dialog 关闭；pending row 消失；切 rejected 回查同 row
 * data-status=rejected、显示 reviewReason、「已处理」，且不显示 approve/reject
 * 操作按钮（reject 成功后仅展示结果，不再可操作）。
 *
 * withdraw vs stale review 竞态（第 10 个用例；冻结依据 D-CAT-10 / AC-CAT-012 /
 * CHK-CAT-008 / AC-CAT-013；本卡绝不引入任何其他 D-CAT 编号）：同一会话内完成
 * 「创建 + 竞态」，无额外 prep。merchant page 真实表单创建唯一 pending，严格
 * parseApplication + readCreatePayload，保存局部正整数 raceApplicationId；从
 * test.info().project.use.baseURL 读 string（非 string 明确 throw），用
 * browser.newContext({ baseURL }) 开隔离 adminContext/adminPage（try/finally 关闭）；
 * adminPage 真实 admin MFA 登录 → /admin → 目录治理，按 application-row-
 * <raceApplicationId> 精准定位 pending，点击 application-approve-new-<id> 打开 stale
 * create_new dialog（断言 code/label/description 预填，填 review-icon='folder-tree' +
 * 常量 RACE_REASON，保持弹窗打开不提交）；回 merchant page 对同一 pending 点击
 * application-withdraw-<id> → 真实 confirm dialog 确认，点击前精确 waitForResponse POST
 * /api/merchant/category-applications/<id>/withdraw 断言 200，复用
 * parseWithdrawnApplication，toast「申请已撤回」，merchant row 变 withdrawn；此时 admin
 * stale dialog 仍打开，点击前精确 waitForResponse POST /api/admin/category-applications/
 * <id>/approve 断言响应 409，unknown JSON 用 readErrorCode 断言
 * CATEGORY_APPLICATION_ALREADY_REVIEWED，请求 body 用现有 readApproveCreateNewPayload
 * 严格断言精确 create_new payload；admin UI toast「该申请已被审核或已撤回，无法重复操作」
 * + dialog 关闭 + 默认 pending row 消失（组件冲突路径 refreshApplications）+ 绝无成功 toast
 * 「已通过并新建分类」；切 admin-application-status-filter=withdrawn 回查同 row
 * data-status=withdrawn、显示「已处理」、无 approve/map/reject 按钮；409 绝不被伪造成
 * 成功，且绝不断言任何新分类产生。
 *
 * 硬约束：无 mock / 无 DB 直读直写 / 无 page.reload / 无 waitForTimeout /
 * 无 page.route / 无写 API 替代 UI 提交 / 无 any / 无 ts-ignore。
 *
 * 已覆盖（REQ-CAT-F-007 / D-CAT-06 / D-CAT-17 / AC-CAT-010 / AC-CAT-011 /
 * CHK-CAT-001~004 / CHK-CAT-012）——第 11 个用例：admin 分类仓库真实 UI create + edit
 *（冻结编号，本卡不使用 D-CAT-12）：
 *   a. 真实 admin MFA loginAs → /admin → 「目录治理」→ admin-category-manager，
 *      断言默认 category filter = 全部（admin-category-status-filter value ''）；
 *   b. admin-category-create 打开「新建分类」dialog；先验证 code 必填本地校验
 *      （分类编码不能为空）且用 page request 事件精确计数证明零请求（禁 sleep）；
 *      再填唯一合法 lower-case code / 唯一 label / description / kebab iconKey /
 *      合法平台资源 defaultCoverUrl（/assets/…）/ sortOrder 整数；
 *   c. 点击前精确 waitForResponse POST /api/admin/product-categories → 201；create
 *      request unknown JSON 类型守卫严格精确六键 {code,label,description,iconKey,
 *      defaultCoverUrl,sortOrder}，无 status/createdByUserId/updatedByUserId/actor/
 *      user/admin；create response 用严格 CategoryAdminDto parser/allowlist（仅
 *      id/code/label/normalizedLabel/iconKey/sortOrder/description/defaultCoverUrl/
 *      status/createdByUserId/updatedByUserId/createdAt/updatedAt，拒绝额外键、
 *      relations/secrets），id/creator/updater 正整数、status active、提交字段精确、
 *      normalizedLabel 为 label trim lowercase、ISO 时间戳，保存正整数 categoryId；
 *   d. toast「分类已创建」+ dialog 关闭 + 列表自行刷新；点击 create submit 前监听
 *      精确 GET /api/admin/product-categories（page=1&pageSize=10、status 缺失/空），
 *      从 unknown 严格读 total/page/pageSize 计算 totalPages；先看第一页，未找到时用
 *      admin-category-pagination「下一页」逐页导航（每次点击前监听精确对应 page GET、
 *      status 200、页参数精确）真实分页定位新建行——新分类 sortOrder 初始 999_999 接近
 *      schema 最大值，不假定其必在末页；每页响应后用 UI 页码断言同步再判断行可见，
 *      杜绝响应到达而 DOM 未更新竞态；category-row-<id> data-status=active 且
 *      显示 code/label/description/sortOrder；
 *   e. category-edit-<id> 打开「编辑分类」，完整字段回填，category-form-code 原
 *      code 且 disabled，出现「编码创建后不可修改（D-CAT-06）」；
 *   f. 修改 label/description/icon/defaultCover/sortOrder；点击前精确 waitForResponse
 *      PATCH /api/admin/product-categories/:id → 200；edit request 严格精确五键
 *      {label,description,iconKey,defaultCoverUrl,sortOrder}，绝无 code/status/操作者
 *      ID；edit response 复用同一严格 parser：id/code 不变、所有修改值精确、active；
 *   g. toast「分类已更新」+ dialog 关闭 + 编辑后列表刷新停在 currentCategoryPage（点击
 *      前监听精确 page=currentCategoryPage GET、status 200、页参数精确）；随后真实
 *      「下一页」逐页导航到末页后，显示新 label/description/sortOrder、旧 label 不再
 *      显示、edit button aria-label 更新。
 *
 * 已覆盖（D-CAT-22 / CHK-CAT-011）——第 12 个用例：admin 分类仓库真实 UI 停用分类：
 *   a. 复用第 11 用例保存的正整数 categoryId（先断言 >0）；真实 admin MFA loginAs → /admin →
 *      点击「目录治理」前先监听精确 GET /api/admin/product-categories（page=1&pageSize=10、
 *      status 缺失/空），从 unknown 严格读 total/page/pageSize 计算 totalPages；
 *   b. admin-category-pagination「下一页」真实逐页走到末页（每次点击前监听精确对应 page GET、
 *      status 200、页参数精确，并用 UI 页码断言同步）后，定位 category-row-<id> 为 active
 *      （上一用例已编辑的 code/label_edit 仍在末页，sortOrder=1_000_000 保证落末页）；
 *   c. 第一次点 category-deactivate-<id>：断言 ConfirmDialog 标题「停用分类」+ 提示
 *      「历史已发布商品仍可显示该分类，但新商品首次发布不能使用」，点「取消」关闭并证明
 *      零 deactivate POST（page request 精确计数，禁 sleep）；
 *   d. 第二次点 category-deactivate-<id>：点击 dialog 内精确「停用」按钮前同时监听精确
 *      POST /api/admin/product-categories/<id>/deactivate 与末页列表 refresh GET；断言
 *      POST 200、请求体过现有 isEmptyMutationPayload、响应过严格 parseCategoryAdminDto 且
 *      status=inactive、id/code 不变；refresh GET status 200 且 page=末页、pageSize=10；
 *   e. toast「分类已停用；历史商品仍可读取」+ dialog 关闭（禁止 page.reload）；同一行
 *      data-status=inactive、inactive-historical-label 文案「历史分类（已发布商品仍显示，
 *      不可用于新商品首次发布）」、category-deactivate-<id> 消失、category-activate-<id>
 *      出现；deactivate POST 总计 1。
 */

/** 唯一申请名称（每次运行不同，避免 pending duplicate 撞车）。 */
const LABEL = `E2E分类申请-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
/** 唯一建议编码（仅建议，平台可调整；满足 ^[A-Za-z0-9_-]+$）。 */
const CODE = `e2e_cat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
/** duplicate 用例的合法建议编码（与 CODE 不同避免撞码；重复判定走 normalizedLabel，与编码无关）。 */
const CODE_DUPLICATE = `e2e_cat_dup_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
/** 至少 20 字的描述（表单校验：description.trim().length >= 20）。 */
const DESCRIPTION = '这是一条用于端到端验证分类申请流程的自动化测试描述，长度远超二十个字符以保证通过表单校验。'
/** 示例商品（可选字段，本卡填满以覆盖四 allowlist 字段）。 */
const EXAMPLE_PRODUCTS = '云服务订阅、数据看板、团队协作工具'

/** 额外 pending 数据准备：唯一 label（与 LABEL 不同避免语义混淆），供后续管理员审核。 */
const ADMIN_REVIEW_LABEL = `E2E待审分类-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
/** 合法 lower-case 分类编码（满足 CATEGORY_CODE_PATTERN：小写字母开头、仅小写/数字/-/_），
 *  供后续 admin create_new 审核直接复用。 */
const ADMIN_REVIEW_CODE = `e2e-admin-review-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
/** ≥20 字的描述（表单校验：description.trim().length >= 20）。 */
const ADMIN_REVIEW_DESCRIPTION = '这是为平台管理员审核准备的分类申请描述，用于后续 admin review 端到端验证，长度满足表单校验要求。'
/** 管理员审核理由常量（1..500 字、无控制字符；请求与响应 reviewReason 精确断言共用）。 */
const ADMIN_REVIEW_REASON = 'E2E 管理员审核：名称与编码均符合分类规范，通过并新建分类。'
/** map_existing 数据准备：唯一 label（与 LABEL / ADMIN_REVIEW_LABEL 不同避免语义混淆），
 *  供后续 admin map_existing 审核把本 pending 映射到前一 create_new 已生成的 approvedCategoryId。 */
const MAP_REVIEW_LABEL = `E2E映射分类-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
/** 合法 lower-case 分类编码（满足 CATEGORY_CODE_PATTERN：小写字母开头、仅小写/数字/-/_），
 *  供后续 admin map_existing 审核直接复用。 */
const MAP_REVIEW_CODE = `e2e-map-review-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
/** ≥20 字的描述（表单校验：description.trim().length >= 20）。 */
const MAP_REVIEW_DESCRIPTION = '这是为平台管理员 map_existing 审核准备的分类申请描述，用于后续映射到已建分类的端到端验证，长度满足表单校验要求。'
/** map_existing 审核理由常量（1..500 字、无控制字符；请求与响应 reviewReason 精确断言共用）。 */
const MAP_REVIEW_REASON = 'E2E 管理员审核：该申请与既有已建分类语义一致，映射到现有分类，不新建分类。'
/** reject 数据准备：唯一 label（与 LABEL / ADMIN_REVIEW_LABEL / MAP_REVIEW_LABEL 不同避免语义混淆），
 *  供后续 admin reject 审核把本 pending 拒绝（D-CAT-10 / D-CAT-11）。 */
const REJECT_REVIEW_LABEL = `E2E拒绝分类-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
/** 合法 lower-case 分类编码（满足 CATEGORY_CODE_PATTERN：小写字母开头、仅小写/数字/-/_）。 */
const REJECT_REVIEW_CODE = `e2e-reject-review-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
/** ≥20 字的描述（表单校验：description.trim().length >= 20）。 */
const REJECT_REVIEW_DESCRIPTION = '这是为平台管理员 reject 审核准备的分类申请描述，用于后续管理员拒绝流程的端到端验证，长度满足表单校验要求。'
/** reject 审核理由常量（1..500 字、无控制字符；请求与响应 reviewReason 精确断言共用）。 */
const REJECT_REVIEW_REASON = 'E2E 管理员审核：申请信息与平台分类规范不符，予以拒绝。'

/** 竞态用例数据准备：唯一 label（与 LABEL / ADMIN_REVIEW_LABEL / MAP_REVIEW_LABEL /
 *  REJECT_REVIEW_LABEL 不同避免语义混淆）。本用例自身完成「创建 + 竞态」，无额外 prep。 */
const RACE_LABEL = `E2E竞态分类-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
/** 合法 lower-case 分类编码（满足 CATEGORY_CODE_PATTERN：小写字母开头、仅小写/数字/-/_），
 *  供 stale admin create_new dialog 直接复用为分类 code。 */
const RACE_CODE = `e2e-race-review-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
/** ≥20 字的描述（表单校验：description.trim().length >= 20）。 */
const RACE_DESCRIPTION = '这是用于验证管理员陈旧审核弹窗与商家撤回竞态的端到端分类申请描述，长度满足表单校验要求。'
/** 竞态审核理由常量（1..500 字、无控制字符；stale approve 请求体 reviewReason 精确断言共用）。 */
const RACE_REASON = 'E2E 竞态审核：该申请提交审核前已被商家撤回，管理员不应能再次通过或新建分类。'

/** admin 分类仓库 create→edit 用例：唯一合法 lower-case 分类编码（CATEGORY_CODE_PATTERN）。 */
const ADMIN_CATEGORY_CODE = `e2e-admin-cat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
/** 唯一 label（≤50 字；含大写 E2E 以验证 normalizedLabel 为 trim lowercase）。 */
const ADMIN_CATEGORY_LABEL = `E2E仓库分类-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
/** 分类描述（≤500 字；create 请求六键之一）。 */
const ADMIN_CATEGORY_DESCRIPTION = '这是通过平台分类仓库真实表单创建的分类描述，用于端到端验证管理员创建与编辑展示信息，长度满足表单校验要求。'
/** kebab-case iconKey（categoryIconKeyPattern：字母/数字/连字符）。 */
const ADMIN_CATEGORY_ICON = 'folder-tree'
/** 合法平台资源 defaultCoverUrl（isPlatformPublicAssetUrl：/assets/… 仓库静态资源）。 */
const ADMIN_CATEGORY_COVER = '/assets/e2e-category-cover.svg'
/** 初始排序值：接近 schema 最大值（MAX_CATEGORY_SORT_ORDER=1_000_000）而非默认小值，
 * 保证重复 E2E 运行累积后新分类仍大概率落在靠后页，配合真实分页逐页定位
 * category-row-<id>（先查第一页、未找到再逐页导航），不依赖"必在末页"假设。
 * 与 ADMIN_CATEGORY_SORT_EDIT 不同且均合法（0..1_000_000）。 */
const ADMIN_CATEGORY_SORT = 999_999
/** edit 变体：唯一新 label（与 ADMIN_CATEGORY_LABEL 不同避免撞名）。 */
const ADMIN_CATEGORY_LABEL_EDIT = `E2E仓库分类已编辑-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
/** edit 变体：新描述（PATCH 五键之一）。 */
const ADMIN_CATEGORY_DESCRIPTION_EDIT = '编辑后的分类描述：管理员在编辑对话框中修改展示信息并保存，端到端验证 PATCH 路径与列表刷新。'
/** edit 变体：新 kebab iconKey。 */
const ADMIN_CATEGORY_ICON_EDIT = 'network'
/** edit 变体：新平台资源 defaultCoverUrl。 */
const ADMIN_CATEGORY_COVER_EDIT = '/assets/e2e-category-cover-edit.svg'
/** edit 变体：新排序值 = schema 最大值 1_000_000（与初始值 999_999 不同且均合法）。
 * edit 后列表 refresh 停在 currentCategoryPage，再以真实「下一页」逐页导航到末页后
 * 断言 category-row-<id> 的新字段；不依赖 refresh 保留末页的假设。 */
const ADMIN_CATEGORY_SORT_EDIT = 1_000_000
/** 分类仓库 create 响应解析出的分类 id（正整数；第 11 个用例内自足使用）。 */
let categoryId = 0
let applicationId = 0

/** 额外 pending 数据准备：为后续管理员审核创建的新申请 id（正整数）。 */
let adminReviewApplicationId = 0
/** admin create_new 审核响应解析出的新建分类 id（正整数）。 */
let approvedCategoryId = 0

/** map_existing 数据准备：为后续管理员 map_existing 审核创建的新申请 id（正整数）。 */
let mapReviewApplicationId = 0
/** reject 数据准备：为后续 admin reject 审核创建的新申请 id（正整数）。 */
let rejectReviewApplicationId = 0

/** unknown JSON → 记录（类型守卫）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 正整数类型守卫。 */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * 错误响应 unknown JSON → error.code（严格类型守卫，禁止 any）。服务端
 * errorHandler 稳定输出 { error: { code, message } }（server/src/middlewares/
 * errorHandler.ts）；任何形状不符直接抛错，绝不静默返回伪造值。
 */
function readErrorCode(body: unknown): string {
  if (!isRecord(body)) throw new Error('错误响应不是 JSON 对象')
  const error = body.error
  if (!isRecord(error)) throw new Error('错误响应缺少 error 对象')
  if (typeof error.code !== 'string' || error.code.length === 0) {
    throw new Error('错误响应缺少非空 string code')
  }
  return error.code
}

/** 从 create 响应 unknown JSON 安全解析申请：id 必须正整数，label/code/status 与提交的 expected 精确匹配。 */
function parseApplication(
  body: unknown,
  expected: { label: string; code: string },
): { id: number; label: string; code: string; status: string } {
  if (!isRecord(body)) throw new Error('创建分类申请响应不是 JSON 对象')
  if (!isPositiveInteger(body.id)) throw new Error('创建分类申请响应缺少正整数 id')
  if (typeof body.proposedLabel !== 'string' || body.proposedLabel !== expected.label) {
    throw new Error('创建分类申请响应 proposedLabel 与提交值不匹配')
  }
  if (typeof body.proposedCode !== 'string' || body.proposedCode !== expected.code) {
    throw new Error('创建分类申请响应 proposedCode 与提交值不匹配')
  }
  if (body.status !== 'pending') {
    throw new Error(`创建分类申请响应 status 非 pending，实际: ${String(body.status)}`)
  }
  return { id: body.id, label: body.proposedLabel, code: body.proposedCode, status: body.status }
}

/**
 * 从 withdraw 响应 unknown JSON 严格解析撤回结果（类型守卫，禁止 any）：
 * id 必须等于 applicationId 且 status==='withdrawn'；任何形状不符直接抛错。
 */
function parseWithdrawnApplication(body: unknown, applicationId: number): { id: number; status: 'withdrawn' } {
  if (!isRecord(body)) throw new Error('撤回分类申请响应不是 JSON 对象')
  if (!isPositiveInteger(body.id) || body.id !== applicationId) {
    throw new Error(`撤回分类申请响应 id 非预期，期望 ${applicationId}，实际 ${String(body.id)}`)
  }
  if (body.status !== 'withdrawn') {
    throw new Error(`撤回分类申请响应 status 非 withdrawn，实际 ${String(body.status)}`)
  }
  return { id: body.id, status: body.status }
}

/**
 * 请求 JSON unknown → create payload（类型守卫）。必须精确四 allowlist 字段
 * （proposedLabel/proposedCode/description/exampleProducts），且明确无
 * merchantId/status（服务端从 auth 派生归属，body 永远不允许）；形状不符返回 null。
 */
function readCreatePayload(
  body: unknown,
): { proposedLabel: string; proposedCode: string; description: string; exampleProducts: string } | null {
  if (!isRecord(body)) return null
  if (typeof body.proposedLabel !== 'string') return null
  if (typeof body.proposedCode !== 'string') return null
  if (typeof body.description !== 'string') return null
  if (typeof body.exampleProducts !== 'string') return null
  if (Object.keys(body).length !== 4) return null
  if ('merchantId' in body || 'status' in body) return null
  return {
    proposedLabel: body.proposedLabel,
    proposedCode: body.proposedCode,
    description: body.description,
    exampleProducts: body.exampleProducts,
  }
}

/**
 * CategoryApplication 响应 DTO 冻结允许键（server/src/modules/catalog/contracts.ts
 * CategoryApplicationDto）。服务端只允许返回这些公开字段；normalizedLabel、
 * reviewedByUserId 等服务端内部/操作者字段绝不允许外泄到响应。
 */
const CATEGORY_APPLICATION_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'merchantId',
  'proposedLabel',
  'proposedCode',
  'description',
  'exampleProducts',
  'status',
  'resolution',
  'approvedCategoryId',
  'reviewedAt',
  'reviewReason',
  'createdAt',
  'updatedAt',
])

/**
 * 显式禁止的内部/操作者字段（即使误加进 allowlist 也必须点名拒绝）：normalizedLabel
 * 是服务端派生字段，reviewedByUserId/actorId/adminUserId/userId 是操作者/审计 ID。
 * 注意 merchantId 是冻结 DTO 合法公开字段，不在禁止之列。
 */
const CATEGORY_APPLICATION_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'normalizedLabel',
  'reviewedByUserId',
  'actorId',
  'adminUserId',
  'userId',
])

/**
 * 从 admin approve(create_new) 响应 unknown JSON 严格解析审核结果（类型守卫，禁止
 * any/as any）：id 必须等于提交的 applicationId、status==='approved'、
 * resolution==='create_new'、approvedCategoryId 必须正整数、reviewReason 精确匹配；
 * 响应键必须命中冻结 DTO allowlist（任何额外键拒绝，且显式点名内部/操作者 ID）；
 * 任何形状不符直接抛错。
 */
function parseApprovedApplication(
  body: unknown,
  expected: { id: number; reviewReason: string },
): {
  id: number
  status: 'approved'
  resolution: 'create_new'
  approvedCategoryId: number
  reviewReason: string
} {
  if (!isRecord(body)) throw new Error('审核分类申请响应不是 JSON 对象')

  // 显式点名内部/操作者字段（即使将来误入 allowlist 也单独拒绝，防回归）。
  const forbiddenKeys = [...CATEGORY_APPLICATION_FORBIDDEN_KEYS].filter((key) => key in body)
  if (forbiddenKeys.length > 0) {
    throw new Error(`审核分类申请响应泄露内部/操作者字段: ${forbiddenKeys.join(', ')}`)
  }

  // 冻结 DTO allowlist：任何额外键一律拒绝（merchantId 是合法公开字段，不在禁止之列）。
  const extraKeys = Object.keys(body).filter((key) => !CATEGORY_APPLICATION_ALLOWED_KEYS.has(key))
  if (extraKeys.length > 0) {
    throw new Error(`审核分类申请响应含未允许字段: ${extraKeys.join(', ')}`)
  }
  if (!isPositiveInteger(body.id) || body.id !== expected.id) {
    throw new Error(`审核分类申请响应 id 非预期，期望 ${expected.id}，实际 ${String(body.id)}`)
  }
  if (body.status !== 'approved') {
    throw new Error(`审核分类申请响应 status 非 approved，实际 ${String(body.status)}`)
  }
  if (body.resolution !== 'create_new') {
    throw new Error(`审核分类申请响应 resolution 非 create_new，实际 ${String(body.resolution)}`)
  }
  if (!isPositiveInteger(body.approvedCategoryId)) {
    throw new Error('审核分类申请响应缺少正整数 approvedCategoryId')
  }
  if (body.reviewReason !== expected.reviewReason) {
    throw new Error('审核分类申请响应 reviewReason 与提交值不匹配')
  }
  return {
    id: body.id,
    status: 'approved',
    resolution: 'create_new',
    approvedCategoryId: body.approvedCategoryId,
    reviewReason: body.reviewReason,
  }
}

/**
 * 请求 JSON unknown → approve(create_new) payload（类型守卫）。必须精确顶层三键
 * { resolution, category, reviewReason } 且 category 精确四键 { code, label,
 * description, iconKey }；任何多余键（含 reviewer/user/admin ID，操作者由服务端
 * 从 auth 派生）或形状不符直接返回 null。
 */
function readApproveCreateNewPayload(
  body: unknown,
): {
  resolution: 'create_new'
  category: { code: string; label: string; description: string; iconKey: string }
  reviewReason: string
} | null {
  if (!isRecord(body)) return null
  if (Object.keys(body).length !== 3) return null
  if (body.resolution !== 'create_new') return null
  if (typeof body.reviewReason !== 'string') return null
  if (!isRecord(body.category)) return null
  const category = body.category
  if (Object.keys(category).length !== 4) return null
  if (typeof category.code !== 'string') return null
  if (typeof category.label !== 'string') return null
  if (typeof category.description !== 'string') return null
  if (typeof category.iconKey !== 'string') return null
  return {
    resolution: 'create_new',
    category: {
      code: category.code,
      label: category.label,
      description: category.description,
      iconKey: category.iconKey,
    },
    reviewReason: body.reviewReason,
  }
}

/**
 * 分类仓库列表响应 total（真实 read network 解析，禁止 any）：listCategories 分页信封
 * { items, total, page, pageSize } 中的 total 必须是非负整数；任何形状不符直接抛错。
 */
function readCategoryListTotal(body: unknown): number {
  if (!isRecord(body)) throw new Error('分类列表响应不是 JSON 对象')
  if (typeof body.total !== 'number' || !Number.isInteger(body.total) || body.total < 0) {
    throw new Error('分类列表响应缺少非负整数 total')
  }
  return body.total
}

/**
 * 分类仓库列表分页信封（真实 read network 解析，禁止 any）：{ items, total, page,
 * pageSize } 中的 total 非负整数、page/pageSize 正整数；任何形状不符直接抛错。
 * 用于从 create/edit 后的列表刷新响应计算 totalPages，并以 AdminPagination 导航到
 * 新建项所在末页。
 */
function readCategoryListPageInfo(body: unknown): { total: number; page: number; pageSize: number } {
  if (!isRecord(body)) throw new Error('分类列表响应不是 JSON 对象')
  if (typeof body.total !== 'number' || !Number.isInteger(body.total) || body.total < 0) {
    throw new Error('分类列表响应缺少非负整数 total')
  }
  if (typeof body.page !== 'number' || !Number.isInteger(body.page) || body.page < 1) {
    throw new Error('分类列表响应缺少正整数 page')
  }
  if (typeof body.pageSize !== 'number' || !Number.isInteger(body.pageSize) || body.pageSize < 1) {
    throw new Error('分类列表响应缺少正整数 pageSize')
  }
  return { total: body.total, page: body.page, pageSize: body.pageSize }
}

/**
 * 精确分类列表 GET 谓词（禁止 any）：参数 (status: 'active'|'inactive'|'', page)。
 * 精确匹配 pathname=/api/admin/product-categories、GET、page=page、pageSize=10（与
 * AdminCategoryManager 的 PAGE_SIZE=10 一致）；status 为空字符串时接受缺失或空 status
 * 参数（axios 省略 undefined 的行为），非空时必须是精确值。
 */
function isCategoryRepositoryListPageFiltered(
  status: 'active' | 'inactive' | '',
  page: number,
): (response: { url(): string; request(): { method(): string } }) => boolean {
  return (response) => {
    const url = new URL(response.url())
    if (url.pathname !== '/api/admin/product-categories') return false
    if (response.request().method() !== 'GET') return false
    if (url.searchParams.get('page') !== String(page)) return false
    if (url.searchParams.get('pageSize') !== '10') return false
    if (status === '') {
      const queryStatus = url.searchParams.get('status')
      return queryStatus === null || queryStatus === ''
    }
    return url.searchParams.get('status') === status
  }
}

/**
 * 精确匹配某页的分类仓库列表 GET（status 缺失/空、page=page、pageSize=10，与
 * AdminCategoryManager 的 PAGE_SIZE=10 及 axios 省略 status 的行为一致）。返回类型
 * 守卫谓词供 waitForResponse 逐页监听使用（禁止 any）。
 */
function isCategoryRepositoryListPage(
  page: number,
): (response: { url(): string; request(): { method(): string } }) => boolean {
  return isCategoryRepositoryListPageFiltered('', page)
}

/**
 * 从 admin approve(map_existing) 响应 unknown JSON 严格解析审核结果（类型守卫，禁止
 * any/as any）：id 必须等于提交的 applicationId、status==='approved'、
 * resolution==='map_existing'、approvedCategoryId 必须精确等于既有 approvedCategoryId、
 * reviewReason 精确匹配；响应键必须命中冻结 DTO allowlist（任何额外键拒绝，且显式点名
 * 内部/操作者 ID）；任何形状不符直接抛错。
 */
function parseMapApprovedApplication(
  body: unknown,
  expected: { id: number; categoryId: number; reviewReason: string },
): {
  id: number
  status: 'approved'
  resolution: 'map_existing'
  approvedCategoryId: number
  reviewReason: string
} {
  if (!isRecord(body)) throw new Error('审核分类申请响应不是 JSON 对象')

  // 显式点名内部/操作者字段（即使将来误入 allowlist 也单独拒绝，防回归）。
  const forbiddenKeys = [...CATEGORY_APPLICATION_FORBIDDEN_KEYS].filter((key) => key in body)
  if (forbiddenKeys.length > 0) {
    throw new Error(`审核分类申请响应泄露内部/操作者字段: ${forbiddenKeys.join(', ')}`)
  }

  // 冻结 DTO allowlist：任何额外键一律拒绝（merchantId 是合法公开字段，不在禁止之列）。
  const extraKeys = Object.keys(body).filter((key) => !CATEGORY_APPLICATION_ALLOWED_KEYS.has(key))
  if (extraKeys.length > 0) {
    throw new Error(`审核分类申请响应含未允许字段: ${extraKeys.join(', ')}`)
  }
  if (!isPositiveInteger(body.id) || body.id !== expected.id) {
    throw new Error(`审核分类申请响应 id 非预期，期望 ${expected.id}，实际 ${String(body.id)}`)
  }
  if (body.status !== 'approved') {
    throw new Error(`审核分类申请响应 status 非 approved，实际 ${String(body.status)}`)
  }
  if (body.resolution !== 'map_existing') {
    throw new Error(`审核分类申请响应 resolution 非 map_existing，实际 ${String(body.resolution)}`)
  }
  if (!isPositiveInteger(body.approvedCategoryId) || body.approvedCategoryId !== expected.categoryId) {
    throw new Error(`审核分类申请响应 approvedCategoryId 非预期，期望 ${expected.categoryId}，实际 ${String(body.approvedCategoryId)}`)
  }
  if (body.reviewReason !== expected.reviewReason) {
    throw new Error('审核分类申请响应 reviewReason 与提交值不匹配')
  }
  return {
    id: body.id,
    status: 'approved',
    resolution: 'map_existing',
    approvedCategoryId: body.approvedCategoryId,
    reviewReason: body.reviewReason,
  }
}

/**
 * 请求 JSON unknown → approve(map_existing) payload（类型守卫）。必须精确顶层三键
 * { resolution, categoryId, reviewReason }：resolution==='map_existing'、categoryId
 * 正整数、reviewReason 字符串；任何多余键（category 块 / reviewer/user/admin 操作者
 * ID，操作者由服务端从 auth 派生）或形状不符直接返回 null。
 */
function readApproveMapExistingPayload(
  body: unknown,
): { resolution: 'map_existing'; categoryId: number; reviewReason: string } | null {
  if (!isRecord(body)) return null
  if (Object.keys(body).length !== 3) return null
  if (body.resolution !== 'map_existing') return null
  if (!isPositiveInteger(body.categoryId)) return null
  if (typeof body.reviewReason !== 'string') return null
  // 精确三键已由 length 校验锁定：category 块或操作者 ID 必然使长度溢出，此处显式点名拒绝。
  if ('category' in body || 'reviewer' in body || 'user' in body || 'admin' in body) return null
  return {
    resolution: 'map_existing',
    categoryId: body.categoryId,
    reviewReason: body.reviewReason,
  }
}
/**
 * 从 admin reject 响应 unknown JSON 严格解析拒绝结果（类型守卫，禁止 any/as any）：
 * id 必须等于提交的 applicationId、status==='rejected'、resolution===null、
 * approvedCategoryId===null、reviewReason 精确匹配；响应键必须命中冻结 DTO allowlist
 * （任何额外键拒绝，且显式点名内部/操作者 ID）；任何形状不符直接抛错。
 */
function parseRejectedApplication(
  body: unknown,
  expected: { id: number; reviewReason: string },
): {
  id: number
  status: 'rejected'
  resolution: null
  approvedCategoryId: null
  reviewReason: string
} {
  if (!isRecord(body)) throw new Error('拒绝分类申请响应不是 JSON 对象')

  // 显式点名内部/操作者字段（即使将来误入 allowlist 也单独拒绝，防回归）。
  const forbiddenKeys = [...CATEGORY_APPLICATION_FORBIDDEN_KEYS].filter((key) => key in body)
  if (forbiddenKeys.length > 0) {
    throw new Error(`拒绝分类申请响应泄露内部/操作者字段: ${forbiddenKeys.join(', ')}`)
  }

  // 冻结 DTO allowlist：任何额外键一律拒绝（merchantId 是合法公开字段，不在禁止之列）。
  const extraKeys = Object.keys(body).filter((key) => !CATEGORY_APPLICATION_ALLOWED_KEYS.has(key))
  if (extraKeys.length > 0) {
    throw new Error(`拒绝分类申请响应含未允许字段: ${extraKeys.join(', ')}`)
  }
  if (!isPositiveInteger(body.id) || body.id !== expected.id) {
    throw new Error(`拒绝分类申请响应 id 非预期，期望 ${expected.id}，实际 ${String(body.id)}`)
  }
  if (body.status !== 'rejected') {
    throw new Error(`拒绝分类申请响应 status 非 rejected，实际 ${String(body.status)}`)
  }
  if (body.resolution !== null) {
    throw new Error(`拒绝分类申请响应 resolution 非 null，实际 ${String(body.resolution)}`)
  }
  if (body.approvedCategoryId !== null) {
    throw new Error(`拒绝分类申请响应 approvedCategoryId 非 null，实际 ${String(body.approvedCategoryId)}`)
  }
  if (body.reviewReason !== expected.reviewReason) {
    throw new Error('拒绝分类申请响应 reviewReason 与提交值不匹配')
  }
  return {
    id: body.id,
    status: 'rejected',
    resolution: null,
    approvedCategoryId: null,
    reviewReason: body.reviewReason,
  }
}

/**
 * 请求 JSON unknown → reject payload（类型守卫）。必须精确一键 { reviewReason }；
 * 任何多余键（含 reviewer/user/admin 操作者 ID、resolution、categoryId 等，操作者由
 * 服务端从 auth 派生）或形状不符直接返回 null。
 */
function readRejectPayload(body: unknown): { reviewReason: string } | null {
  if (!isRecord(body)) return null
  if (Object.keys(body).length !== 1) return null
  if (typeof body.reviewReason !== 'string') return null
  return { reviewReason: body.reviewReason }
}

/**
 * CategoryAdminDto 响应冻结允许键（server/src/modules/catalog/contracts.ts
 * CategoryAdminDto；与 server 端 toAdminDto 输出完全一致）。服务端只允许返回这些
 * 公开字段；任何额外键（含 relations/secrets）一律拒绝。注意 createdByUserId /
 * updatedByUserId / normalizedLabel 是合法 admin DTO 字段（REQ-CAT-F-007），
 * 绝不允许被误判为泄露而拒绝。
 */
const CATEGORY_ADMIN_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'code',
  'label',
  'normalizedLabel',
  'iconKey',
  'sortOrder',
  'description',
  'defaultCoverUrl',
  'status',
  'createdByUserId',
  'updatedByUserId',
  'createdAt',
  'updatedAt',
])

/**
 * 显式禁止的 relations/secrets（即使误加进 allowlist 也必须点名拒绝）：products /
 * approvedApplications / _count 是 Prisma relation/计数，createdByUser / updatedByUser
 * 是关系对象；merchantId 属于申请 DTO，绝不属于 admin 分类 DTO。
 */
const CATEGORY_ADMIN_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'products',
  'approvedApplications',
  '_count',
  'createdByUser',
  'updatedByUser',
  'merchantId',
])

/** ISO 8601 UTC 时间戳类型守卫（Prisma toISOString 输出，毫秒精度 + Z）。 */
function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
}

/**
 * 从 admin 分类仓库 create/update 响应 unknown JSON 严格解析 CategoryAdminDto（类型
 * 守卫，禁止 any/as any）：响应键必须命中冻结 allowlist（任何额外键拒绝，且显式点名
 * relations/secrets）；id/createdByUserId/updatedByUserId 必须正整数、status 必须等于 expected.status、
 * 提交字段（code/label/description/iconKey/defaultCoverUrl/sortOrder）精确匹配、
 * normalizedLabel 必须等于 label trim lowercase、createdAt/updatedAt 必须 ISO 时间戳；
 * 任何形状不符直接抛错，绝不静默返回伪造值。
 */
function parseCategoryAdminDto(
  body: unknown,
  expected: {
    code: string
    label: string
    description: string
    iconKey: string
    defaultCoverUrl: string
    sortOrder: number
    status: 'active' | 'inactive'
  },
): {
  id: number
  code: string
  label: string
  normalizedLabel: string
  iconKey: string
  sortOrder: number
  description: string
  defaultCoverUrl: string
  status: 'active' | 'inactive'
  createdByUserId: number
  updatedByUserId: number
  createdAt: string
  updatedAt: string
} {
  if (!isRecord(body)) throw new Error('分类仓库响应不是 JSON 对象')

  // 显式点名 relations/secrets（即使将来误入 allowlist 也单独拒绝，防回归）。
  const forbiddenKeys = [...CATEGORY_ADMIN_FORBIDDEN_KEYS].filter((key) => key in body)
  if (forbiddenKeys.length > 0) {
    throw new Error(`分类仓库响应泄露关联/敏感字段: ${forbiddenKeys.join(', ')}`)
  }

  // 冻结 CategoryAdminDto allowlist：任何额外键一律拒绝。
  const extraKeys = Object.keys(body).filter((key) => !CATEGORY_ADMIN_ALLOWED_KEYS.has(key))
  if (extraKeys.length > 0) {
    throw new Error(`分类仓库响应含未允许字段: ${extraKeys.join(', ')}`)
  }

  if (!isPositiveInteger(body.id)) throw new Error('分类仓库响应缺少正整数 id')
  if (typeof body.code !== 'string' || body.code !== expected.code) throw new Error('分类仓库响应 code 与提交值不匹配')
  if (typeof body.label !== 'string' || body.label !== expected.label) throw new Error('分类仓库响应 label 与提交值不匹配')
  if (typeof body.normalizedLabel !== 'string' || body.normalizedLabel !== expected.label.trim().toLowerCase()) {
    throw new Error('分类仓库响应 normalizedLabel 非 label 的 trim lowercase')
  }
  if (typeof body.description !== 'string' || body.description !== expected.description) throw new Error('分类仓库响应 description 与提交值不匹配')
  if (typeof body.iconKey !== 'string' || body.iconKey !== expected.iconKey) throw new Error('分类仓库响应 iconKey 与提交值不匹配')
  if (typeof body.defaultCoverUrl !== 'string' || body.defaultCoverUrl !== expected.defaultCoverUrl) throw new Error('分类仓库响应 defaultCoverUrl 与提交值不匹配')
  if (typeof body.sortOrder !== 'number' || !Number.isInteger(body.sortOrder) || body.sortOrder !== expected.sortOrder) {
    throw new Error('分类仓库响应 sortOrder 与提交值不匹配')
  }
  if (body.status !== expected.status) throw new Error(`分类仓库响应 status 非 ${expected.status}，实际: ${String(body.status)}`)
  if (!isPositiveInteger(body.createdByUserId)) throw new Error('分类仓库响应缺少正整数 createdByUserId')
  if (!isPositiveInteger(body.updatedByUserId)) throw new Error('分类仓库响应缺少正整数 updatedByUserId')
  if (!isIsoTimestamp(body.createdAt)) throw new Error('分类仓库响应 createdAt 非 ISO 时间戳')
  if (!isIsoTimestamp(body.updatedAt)) throw new Error('分类仓库响应 updatedAt 非 ISO 时间戳')

  return {
    id: body.id,
    code: body.code,
    label: body.label,
    normalizedLabel: body.normalizedLabel,
    iconKey: body.iconKey,
    sortOrder: body.sortOrder,
    description: body.description,
    defaultCoverUrl: body.defaultCoverUrl,
    status: body.status,
    createdByUserId: body.createdByUserId,
    updatedByUserId: body.updatedByUserId,
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
  }
}

/**
 * 请求 JSON unknown → create category payload（类型守卫）。必须精确六键
 * { code, label, description, iconKey, defaultCoverUrl, sortOrder }；任何多余键
 * （status/createdByUserId/updatedByUserId/actor/user/admin，归属与审计由服务端
 * 从 auth 派生）或形状不符直接返回 null。
 */
function readCreateCategoryPayload(
  body: unknown,
): {
  code: string
  label: string
  description: string
  iconKey: string
  defaultCoverUrl: string
  sortOrder: number
} | null {
  if (!isRecord(body)) return null
  if (Object.keys(body).length !== 6) return null
  if (typeof body.code !== 'string') return null
  if (typeof body.label !== 'string') return null
  if (typeof body.description !== 'string') return null
  if (typeof body.iconKey !== 'string') return null
  if (typeof body.defaultCoverUrl !== 'string') return null
  if (typeof body.sortOrder !== 'number' || !Number.isInteger(body.sortOrder)) return null
  // 精确六键已由 length 校验锁定：服务端派生/操作者字段必然使长度溢出，此处显式点名拒绝。
  if ('status' in body || 'createdByUserId' in body || 'updatedByUserId' in body || 'actor' in body || 'user' in body || 'admin' in body) return null
  return {
    code: body.code,
    label: body.label,
    description: body.description,
    iconKey: body.iconKey,
    defaultCoverUrl: body.defaultCoverUrl,
    sortOrder: body.sortOrder,
  }
}

/**
 * 请求 JSON unknown → update category payload（类型守卫）。必须精确五键
 * { label, description, iconKey, defaultCoverUrl, sortOrder }；绝无 code/status/
 * 操作者 ID（code 不可修改 D-CAT-06，归属与审计由服务端从 auth 派生）——任何多余键
 * 或形状不符直接返回 null。
 */
function readUpdateCategoryPayload(
  body: unknown,
): {
  label: string
  description: string
  iconKey: string
  defaultCoverUrl: string
  sortOrder: number
} | null {
  if (!isRecord(body)) return null
  if (Object.keys(body).length !== 5) return null
  if (typeof body.label !== 'string') return null
  if (typeof body.description !== 'string') return null
  if (typeof body.iconKey !== 'string') return null
  if (typeof body.defaultCoverUrl !== 'string') return null
  if (typeof body.sortOrder !== 'number' || !Number.isInteger(body.sortOrder)) return null
  // 精确五键已由 length 校验锁定：code/status/操作者 ID 必然使长度溢出，此处显式点名拒绝。
  if ('code' in body || 'status' in body || 'createdByUserId' in body || 'updatedByUserId' in body || 'actor' in body || 'user' in body || 'admin' in body) return null
  return {
    label: body.label,
    description: body.description,
    iconKey: body.iconKey,
    defaultCoverUrl: body.defaultCoverUrl,
    sortOrder: body.sortOrder,
  }
}

/**
 * unknown 请求 body 空 payload 守卫（禁止 any/as any）：接受 undefined/null 或空 record；
 * 拒绝数组与任何非空键（任何非 object 或含键的对象一律 false）。
 */
function isEmptyMutationPayload(body: unknown): boolean {
  if (body === undefined || body === null) return true
  if (Array.isArray(body)) return false
  if (typeof body !== 'object') return false
  return Object.keys(body).length === 0
}

test.describe.serial('PAR-CMI-002 catalog category governance merchant flow', () => {
  test('merchant submits a pending category application via the UI', async ({ page }) => {
    await loginAs(page, SEED_ACCOUNTS.merchant)

    // 进入商家后台并切到「分类申请」tab，等待面板渲染。
    await page.goto('/merchant')
    await page.getByRole('button', { name: '分类申请' }).click()
    await expect(page.getByTestId('category-application-panel')).toBeVisible({ timeout: 10_000 })

    // 打开申请表并填写：unique LABEL、CODE、≥20 字描述、示例商品。
    await page.getByTestId('merchant-application-create').click()
    await expect(page.getByTestId('application-form-label')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('application-form-label').fill(LABEL)
    await page.getByTestId('application-form-code').fill(CODE)
    await page.getByTestId('application-form-description').fill(DESCRIPTION)
    await page.getByTestId('application-form-example').fill(EXAMPLE_PRODUCTS)

    // 点击真实提交动作前监听精确 pathname + POST。
    const createResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/merchant/category-applications'
      && response.request().method() === 'POST'
    )
    await page.getByTestId('application-form-submit').click()
    const createResult = await createResponse

    // 真实契约（server applicationRoutes.test.ts）：POST create → 201。
    expect(createResult.status()).toBe(201)

    // 从 unknown JSON 用类型守卫解析并保存正整数 applicationId。
    const createdBody: unknown = await createResult.json()
    const created = parseApplication(createdBody, { label: LABEL, code: CODE })
    applicationId = created.id
    expect(created.label).toBe(LABEL)
    expect(created.code).toBe(CODE)
    expect(created.status).toBe('pending')
    expect(applicationId).toBeGreaterThan(0)

    // 请求 JSON：精确四 allowlist 字段，明确无 merchantId/status。
    const requestBody: unknown = createResult.request().postDataJSON()
    expect(readCreatePayload(requestBody)).toEqual({
      proposedLabel: LABEL,
      proposedCode: CODE,
      description: DESCRIPTION,
      exampleProducts: EXAMPLE_PRODUCTS,
    })

    // toast 成功 + 列表行 data-status=pending。
    await expect(
      page.locator('[data-toast-card]', { hasText: '分类申请已提交，等待平台审核' }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(`application-row-${applicationId}`)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(`application-row-${applicationId}`)).toHaveAttribute('data-status', 'pending')
  })

  test('duplicate pending application is rejected with 409 and the form stays retryable', async ({ page }) => {
    // 串行依赖：前一个 create 用例必须已保存正整数 applicationId。
    expect(applicationId).toBeGreaterThan(0)

    // 独立登录 + 进入 /merchant 分类申请面板。
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByRole('button', { name: '分类申请' }).click()
    await expect(page.getByTestId('category-application-panel')).toBeVisible({ timeout: 10_000 })

    // 打开创建表单：提交与 create 用例相同的 LABEL（pending 已存在 → 重复冲突），
    // 但使用另一个合法且唯一的 CODE_DUPLICATE；description/exampleProducts 保持合法。
    await page.getByTestId('merchant-application-create').click()
    await expect(page.getByTestId('application-form-label')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('application-form-label').fill(LABEL)
    await page.getByTestId('application-form-code').fill(CODE_DUPLICATE)
    await page.getByTestId('application-form-description').fill(DESCRIPTION)
    await page.getByTestId('application-form-example').fill(EXAMPLE_PRODUCTS)

    // 点击真实提交动作前监听精确 pathname + POST。
    const duplicateResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/merchant/category-applications'
      && response.request().method() === 'POST'
    )
    await page.getByTestId('application-form-submit').click()
    const duplicateResult = await duplicateResponse

    // 真实契约（server applicationService.ts）：pending duplicate → 409 + 稳定错误码。
    expect(duplicateResult.status()).toBe(409)
    const duplicateBody: unknown = await duplicateResult.json()
    expect(readErrorCode(duplicateBody)).toBe('CATEGORY_APPLICATION_PENDING_DUPLICATE')

    // UI 稳定文案（getCatalogGovernanceErrorMessage 按码取词，非 prose 匹配）。
    await expect(page.getByTestId('application-form-error')).toHaveText('你已有一个相同名称的分类申请在审核中', { timeout: 10_000 })

    // 失败路径不关闭表单：dialog 保持打开，submit 恢复 enabled。
    await expect(page.getByTestId('application-form-label')).toBeVisible()
    await expect(page.getByTestId('application-form-submit')).toBeEnabled()

    // 修改表单后重试：重复判定走 normalizedLabel，仅改 code 不会消除冲突 → 仍 409。
    await page.getByTestId('application-form-code').fill(`${CODE_DUPLICATE}_retry`)
    const retryResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/merchant/category-applications'
      && response.request().method() === 'POST'
    )
    await page.getByTestId('application-form-submit').click()
    const retryResult = await retryResponse
    expect(retryResult.status()).toBe(409)
    expect(readErrorCode(await retryResult.json())).toBe('CATEGORY_APPLICATION_PENDING_DUPLICATE')
    await expect(page.getByTestId('application-form-error')).toHaveText('你已有一个相同名称的分类申请在审核中')

    // 全程绝不出现成功 toast（成功只会在 create 201 路径触发）。
    await expect(
      page.locator('[data-toast-card]', { hasText: '分类申请已提交，等待平台审核' }),
    ).toHaveCount(0)
  })

  test('merchant withdraws the pending application via the confirm dialog (D-CAT-10)', async ({ page }) => {
    // 串行依赖：create 用例已保存正整数 applicationId，且当前仍为 pending。
    expect(applicationId).toBeGreaterThan(0)

    // 独立登录 + 进入 /merchant 分类申请面板。
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByRole('button', { name: '分类申请' }).click()
    await expect(page.getByTestId('category-application-panel')).toBeVisible({ timeout: 10_000 })

    // 精准定位本卡创建的 pending 行，断言当前 data-status=pending，并定位撤回按钮。
    const row = page.getByTestId(`application-row-${applicationId}`)
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(row).toHaveAttribute('data-status', 'pending')
    const withdrawButton = page.getByTestId(`application-withdraw-${applicationId}`)
    await expect(withdrawButton).toBeVisible()

    // 点击撤回按钮 → 等待确认 dialog。
    await withdrawButton.click()
    const confirmDialog = page.getByRole('dialog')
    await expect(confirmDialog).toBeVisible({ timeout: 10_000 })

    // 必须在 dialog 范围内点击真正的「撤回」确认按钮，避免误点背景里的撤回按钮。
    // 核对实际组件文案（ConfirmDialog: title「撤回分类申请」/ description / 确认按钮）。
    await expect(confirmDialog).toContainText('撤回分类申请')
    await expect(confirmDialog).toContainText('确定撤回')

    // 点击确认前监听精确 pathname + POST withdraw。
    const withdrawResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/merchant/category-applications/${applicationId}/withdraw`
      && response.request().method() === 'POST'
    )
    await confirmDialog.getByRole('button', { name: '撤回', exact: true }).click()
    const withdrawResult = await withdrawResponse

    // 真实契约（server applicationRoutes.test.ts）：POST withdraw → 200。
    expect(withdrawResult.status()).toBe(200)

    // 严格类型守卫：从 unknown JSON 证明 id === applicationId 且 status==='withdrawn'。
    const withdrawBody: unknown = await withdrawResult.json()
    const withdrawn = parseWithdrawnApplication(withdrawBody, applicationId)
    expect(withdrawn.id).toBe(applicationId)
    expect(withdrawn.status).toBe('withdrawn')

    // toast「申请已撤回」。
    await expect(
      page.locator('[data-toast-card]', { hasText: '申请已撤回' }),
    ).toBeVisible({ timeout: 10_000 })

    // 列表自行刷新（禁止 page.reload）：同一行 data-status=withdrawn，
    // 且 application-withdraw-<id> 消失（非 pending 不再渲染撤回按钮）。
    await expect(row).toHaveAttribute('data-status', 'withdrawn', { timeout: 10_000 })
    await expect(page.getByTestId(`application-withdraw-${applicationId}`)).toHaveCount(0)
  })

  test('prepares an extra pending application for the later admin review (D-CAT-11 prep)', async ({ page }) => {
    // 额外 pending 数据准备：独立登录 + 进入 /merchant 分类申请面板。
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByRole('button', { name: '分类申请' }).click()
    await expect(page.getByTestId('category-application-panel')).toBeVisible({ timeout: 10_000 })

    // 打开真实创建表单，填唯一 ADMIN_REVIEW_LABEL / 合法 lower-case ADMIN_REVIEW_CODE /
    // ≥20 字 ADMIN_REVIEW_DESCRIPTION + 合法示例商品。
    await page.getByTestId('merchant-application-create').click()
    await expect(page.getByTestId('application-form-label')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('application-form-label').fill(ADMIN_REVIEW_LABEL)
    await page.getByTestId('application-form-code').fill(ADMIN_REVIEW_CODE)
    await page.getByTestId('application-form-description').fill(ADMIN_REVIEW_DESCRIPTION)
    await page.getByTestId('application-form-example').fill(EXAMPLE_PRODUCTS)

    // 点击真实提交动作前监听精确 pathname + POST。
    const adminReviewCreateResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/merchant/category-applications'
      && response.request().method() === 'POST'
    )
    await page.getByTestId('application-form-submit').click()
    const adminReviewCreateResult = await adminReviewCreateResponse

    // 真实契约（server applicationRoutes.test.ts）：POST create → 201。
    expect(adminReviewCreateResult.status()).toBe(201)

    // 严格类型守卫：从 unknown JSON 断言正整数 id、精确 label/code、status=pending，
    // 保存 adminReviewApplicationId（禁止 any/as any）。
    const adminReviewBody: unknown = await adminReviewCreateResult.json()
    const adminReviewCreated = parseApplication(adminReviewBody, { label: ADMIN_REVIEW_LABEL, code: ADMIN_REVIEW_CODE })
    adminReviewApplicationId = adminReviewCreated.id
    expect(adminReviewCreated.label).toBe(ADMIN_REVIEW_LABEL)
    expect(adminReviewCreated.code).toBe(ADMIN_REVIEW_CODE)
    expect(adminReviewCreated.status).toBe('pending')
    expect(adminReviewApplicationId).toBeGreaterThan(0)

    // 请求 JSON：精确四 allowlist 字段，明确无 merchantId/status（复用既有 readCreatePayload，
    // 未弱化任何断言）。
    const adminReviewRequestBody: unknown = adminReviewCreateResult.request().postDataJSON()
    expect(readCreatePayload(adminReviewRequestBody)).toEqual({
      proposedLabel: ADMIN_REVIEW_LABEL,
      proposedCode: ADMIN_REVIEW_CODE,
      description: ADMIN_REVIEW_DESCRIPTION,
      exampleProducts: EXAMPLE_PRODUCTS,
    })

    // toast 成功 + 列表行 data-status=pending。
    await expect(
      page.locator('[data-toast-card]', { hasText: '分类申请已提交，等待平台审核' }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(`application-row-${adminReviewApplicationId}`)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(`application-row-${adminReviewApplicationId}`)).toHaveAttribute('data-status', 'pending')

    // 本卡仅为后续 admin create_new 审核准备 pending 数据：绝不 withdraw 该申请。
  })

  test('admin approves the prepared application via create_new and the row becomes approved (D-CAT-11)', async ({ page }) => {
    // 串行依赖：第 4 个 pending 数据准备用例必须已保存正整数 adminReviewApplicationId。
    expect(adminReviewApplicationId).toBeGreaterThan(0)

    // 真实 admin MFA 登录（loginAs admin 走 seed TOTP 验证）→ /admin → 「目录治理」。
    await loginAs(page, SEED_ACCOUNTS.admin)
    await page.goto('/admin')
    await page.getByRole('button', { name: '目录治理' }).click()
    await expect(page.getByTestId('admin-category-manager')).toBeVisible({ timeout: 10_000 })

    // 显式断言状态筛选当前 value = 'pending'（组件默认值，非 UI 猜测），
    // 再按 application-row-<id> 精准定位本卡准备的行，断言 pending 后点击
    // application-approve-new-<id> 打开 create_new 审核 dialog。
    await expect(page.getByTestId('admin-application-status-filter')).toHaveValue('pending')
    const row = page.getByTestId(`application-row-${adminReviewApplicationId}`)
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(row).toHaveAttribute('data-status', 'pending')
    await page.getByTestId(`application-approve-new-${adminReviewApplicationId}`).click()

    // review dialog：核对 code/label/description 预填为 ADMIN_REVIEW_*（禁止手工输入
    // 替代预填），再填 review-icon='folder-tree' + 常量 ADMIN_REVIEW_REASON。
    const reviewDialog = page.getByRole('dialog')
    await expect(reviewDialog).toBeVisible({ timeout: 10_000 })
    await expect(reviewDialog.getByTestId('review-code')).toHaveValue(ADMIN_REVIEW_CODE)
    await expect(reviewDialog.getByTestId('review-label')).toHaveValue(ADMIN_REVIEW_LABEL)
    await expect(reviewDialog.getByTestId('review-description')).toHaveValue(ADMIN_REVIEW_DESCRIPTION)
    await reviewDialog.getByTestId('review-icon').fill('folder-tree')
    await reviewDialog.getByTestId('review-reason').fill(ADMIN_REVIEW_REASON)

    // 点击真实提交动作前监听精确 pathname + POST approve。
    const approveResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/admin/category-applications/${adminReviewApplicationId}/approve`
      && response.request().method() === 'POST'
    )
    await reviewDialog.getByTestId('review-submit').click()
    const approveResult = await approveResponse

    // 真实契约（server applicationRoutes.test.ts）：POST approve → 200。
    expect(approveResult.status()).toBe(200)

    // 严格类型守卫：从 unknown JSON 证明 id 相同、status=approved、resolution=create_new、
    // approvedCategoryId 正整数、reviewReason 精确，且响应键命中冻结 DTO allowlist
    // （拒绝任何额外键、显式点名内部/操作者字段）；保存 approvedCategoryId（禁止 any/as any）。
    const approveBody: unknown = await approveResult.json()
    const approved = parseApprovedApplication(approveBody, { id: adminReviewApplicationId, reviewReason: ADMIN_REVIEW_REASON })
    approvedCategoryId = approved.approvedCategoryId
    expect(approved.id).toBe(adminReviewApplicationId)
    expect(approved.status).toBe('approved')
    expect(approved.resolution).toBe('create_new')
    expect(approved.approvedCategoryId).toBeGreaterThan(0)
    expect(approved.reviewReason).toBe(ADMIN_REVIEW_REASON)

    // 请求 JSON：严格等于 { resolution:'create_new', category:{code,label,description,
    // iconKey}, reviewReason }，精确键集合且无 reviewer/user/admin ID。
    const approveRequestBody: unknown = approveResult.request().postDataJSON()
    expect(readApproveCreateNewPayload(approveRequestBody)).toEqual({
      resolution: 'create_new',
      category: {
        code: ADMIN_REVIEW_CODE,
        label: ADMIN_REVIEW_LABEL,
        description: ADMIN_REVIEW_DESCRIPTION,
        iconKey: 'folder-tree',
      },
      reviewReason: ADMIN_REVIEW_REASON,
    })

    // toast「已通过并新建分类」+ review dialog 关闭（Radix unmount 后 role=dialog 消失）。
    await expect(
      page.locator('[data-toast-card]', { hasText: '已通过并新建分类' }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // 默认 pending 列表自行刷新（禁止 page.reload）：application-row-<id> 消失（已转 approved）。
    await expect(page.getByTestId(`application-row-${adminReviewApplicationId}`)).toHaveCount(0, { timeout: 10_000 })

    // 切 admin-application-status-filter=approved 回查同 row：data-status=approved，
    // resolution 显示「新建分类」且包含 #approvedCategoryId。
    await page.getByTestId('admin-application-status-filter').selectOption('approved')
    const approvedRow = page.getByTestId(`application-row-${adminReviewApplicationId}`)
    await expect(approvedRow).toBeVisible({ timeout: 10_000 })
    await expect(approvedRow).toHaveAttribute('data-status', 'approved')
    await expect(page.getByTestId(`application-resolution-${adminReviewApplicationId}`)).toContainText('新建分类')
    await expect(page.getByTestId(`application-resolution-${adminReviewApplicationId}`)).toContainText(`#${approvedCategoryId}`)
  })

  test('prepares a pending application for the later admin map_existing review (map_existing prep)', async ({ page }) => {
    // map_existing 数据准备：独立登录 + 进入 /merchant 分类申请面板。
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByRole('button', { name: '分类申请' }).click()
    await expect(page.getByTestId('category-application-panel')).toBeVisible({ timeout: 10_000 })

    // 打开真实创建表单，填唯一 MAP_REVIEW_LABEL / 合法 lower-case MAP_REVIEW_CODE /
    // ≥20 字 MAP_REVIEW_DESCRIPTION + 合法示例商品。
    await page.getByTestId('merchant-application-create').click()
    await expect(page.getByTestId('application-form-label')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('application-form-label').fill(MAP_REVIEW_LABEL)
    await page.getByTestId('application-form-code').fill(MAP_REVIEW_CODE)
    await page.getByTestId('application-form-description').fill(MAP_REVIEW_DESCRIPTION)
    await page.getByTestId('application-form-example').fill(EXAMPLE_PRODUCTS)

    // 点击真实提交动作前监听精确 pathname + POST。
    const mapReviewCreateResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/merchant/category-applications'
      && response.request().method() === 'POST'
    )
    await page.getByTestId('application-form-submit').click()
    const mapReviewCreateResult = await mapReviewCreateResponse

    // 真实契约（server applicationRoutes.test.ts）：POST create → 201。
    expect(mapReviewCreateResult.status()).toBe(201)

    // 严格类型守卫：从 unknown JSON 断言正整数 id、精确 label/code、status=pending，
    // 保存 mapReviewApplicationId（禁止 any/as any）。
    const mapReviewBody: unknown = await mapReviewCreateResult.json()
    const mapReviewCreated = parseApplication(mapReviewBody, { label: MAP_REVIEW_LABEL, code: MAP_REVIEW_CODE })
    mapReviewApplicationId = mapReviewCreated.id
    expect(mapReviewCreated.label).toBe(MAP_REVIEW_LABEL)
    expect(mapReviewCreated.code).toBe(MAP_REVIEW_CODE)
    expect(mapReviewCreated.status).toBe('pending')
    expect(mapReviewApplicationId).toBeGreaterThan(0)

    // 请求 JSON：精确四 allowlist 字段，明确无 merchantId/status（复用既有 readCreatePayload，
    // 未弱化任何断言）。
    const mapReviewRequestBody: unknown = mapReviewCreateResult.request().postDataJSON()
    expect(readCreatePayload(mapReviewRequestBody)).toEqual({
      proposedLabel: MAP_REVIEW_LABEL,
      proposedCode: MAP_REVIEW_CODE,
      description: MAP_REVIEW_DESCRIPTION,
      exampleProducts: EXAMPLE_PRODUCTS,
    })

    // toast 成功 + 列表行 data-status=pending。
    await expect(
      page.locator('[data-toast-card]', { hasText: '分类申请已提交，等待平台审核' }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(`application-row-${mapReviewApplicationId}`)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(`application-row-${mapReviewApplicationId}`)).toHaveAttribute('data-status', 'pending')

    // 本卡仅为后续 admin map_existing 审核准备 pending 数据：绝不 withdraw 该申请。
  })

  test('admin approves the prepared application via map_existing and the row becomes approved (map_existing review)', async ({ page }) => {
    // 串行依赖：第 6 个 pending 数据准备用例已保存正整数 mapReviewApplicationId，
    // 且第 5 个 create_new 用例已保存正整数 approvedCategoryId（映射目标，active）。
    expect(mapReviewApplicationId).toBeGreaterThan(0)
    expect(approvedCategoryId).toBeGreaterThan(0)

    // 真实 admin MFA 登录 → /admin。
    await loginAs(page, SEED_ACCOUNTS.admin)
    await page.goto('/admin')

    // 点击「目录治理」前建立 before 分类仓库 GET 监听：精确 GET /api/admin/product-categories
    // 且 searchParams：status 缺失或 ''、page='1'、pageSize='10'（组件默认 status ''，
    // axios 省略 undefined → status 参数缺失；双兼容精确匹配）。
    const isCategoryRepositoryList = (response: {
      url(): string
      request(): { method(): string }
    }): boolean => {
      const url = new URL(response.url())
      if (url.pathname !== '/api/admin/product-categories') return false
      if (response.request().method() !== 'GET') return false
      const status = url.searchParams.get('status')
      return (
        (status === null || status === '')
        && url.searchParams.get('page') === '1'
        && url.searchParams.get('pageSize') === '10'
      )
    }
    const beforeCategoriesResponse = page.waitForResponse(isCategoryRepositoryList)
    await page.getByRole('button', { name: '目录治理' }).click()
    const beforeCategoriesResult = await beforeCategoriesResponse
    expect(beforeCategoriesResult.status()).toBe(200)
    const beforeCategoriesBody: unknown = await beforeCategoriesResult.json()
    const beforeCategoriesTotal = readCategoryListTotal(beforeCategoriesBody)

    // 等 admin-category-manager；默认 pending 筛选；按 map row 精准定位并断言 pending。
    await expect(page.getByTestId('admin-category-manager')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('admin-application-status-filter')).toHaveValue('pending')
    const mapRow = page.getByTestId(`application-row-${mapReviewApplicationId}`)
    await expect(mapRow).toBeVisible({ timeout: 10_000 })
    await expect(mapRow).toHaveAttribute('data-status', 'pending')

    // 点击「通过（映射）」打开 map_existing 审核 dialog。
    await page.getByTestId(`application-approve-map-${mapReviewApplicationId}`).click()

    // dialog：核对模式标题「通过并映射现有分类」+ 申请名称（MAP_REVIEW_LABEL）；
    // 在 review-category 下拉选择 String(approvedCategoryId)（既有 create_new 分类为
    // active，必出现在该下拉）并 toHaveValue；再填常量 MAP_REVIEW_REASON。
    const mapDialog = page.getByRole('dialog')
    await expect(mapDialog).toBeVisible({ timeout: 10_000 })
    await expect(mapDialog).toContainText('通过并映射现有分类')
    await expect(mapDialog).toContainText(MAP_REVIEW_LABEL)
    await mapDialog.getByTestId('review-category').selectOption(String(approvedCategoryId))
    await expect(mapDialog.getByTestId('review-category')).toHaveValue(String(approvedCategoryId))
    await mapDialog.getByTestId('review-reason').fill(MAP_REVIEW_REASON)

    // 点击 submit 前同时建立 approve POST 精确 wait 与 after 分类仓库 GET 精确 wait
    // （分类刷新在 approve 成功后触发）；两个 promise 均在点击前建立，先 await approve 再 await after。
    const approveResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/admin/category-applications/${mapReviewApplicationId}/approve`
      && response.request().method() === 'POST'
    )
    const afterCategoriesResponse = page.waitForResponse(isCategoryRepositoryList)
    await mapDialog.getByTestId('review-submit').click()
    const approveResult = await approveResponse
    const afterCategoriesResult = await afterCategoriesResponse

    // 真实契约（server applicationRoutes.test.ts）：POST approve → 200。
    expect(approveResult.status()).toBe(200)

    // 严格类型守卫：从 unknown JSON 证明 id 相同、status=approved、resolution=map_existing、
    // approvedCategoryId 精确等于既有值、reviewReason 精确，且响应键命中冻结 DTO allowlist
    // （拒绝额外键、点名内部/操作者字段）。
    const approveBody: unknown = await approveResult.json()
    const approved = parseMapApprovedApplication(approveBody, {
      id: mapReviewApplicationId,
      categoryId: approvedCategoryId,
      reviewReason: MAP_REVIEW_REASON,
    })
    expect(approved.id).toBe(mapReviewApplicationId)
    expect(approved.status).toBe('approved')
    expect(approved.resolution).toBe('map_existing')
    expect(approved.approvedCategoryId).toBe(approvedCategoryId)
    expect(approved.reviewReason).toBe(MAP_REVIEW_REASON)

    // 请求 JSON：严格等于 { resolution:'map_existing', categoryId, reviewReason } 精确三键，
    // 无 category 块 / reviewer/user/admin 操作者 ID（操作者由服务端从 auth 派生）。
    const approveRequestBody: unknown = approveResult.request().postDataJSON()
    expect(readApproveMapExistingPayload(approveRequestBody)).toEqual({
      resolution: 'map_existing',
      categoryId: approvedCategoryId,
      reviewReason: MAP_REVIEW_REASON,
    })

    // after 分类仓库 GET status 200；total 严格等于 before（map_existing 不新建分类）。
    expect(afterCategoriesResult.status()).toBe(200)
    const afterCategoriesBody: unknown = await afterCategoriesResult.json()
    expect(readCategoryListTotal(afterCategoriesBody)).toBe(beforeCategoriesTotal)

    // toast「已通过并映射到现有分类」+ review dialog 关闭（Radix unmount 后 role=dialog 消失）。
    await expect(
      page.locator('[data-toast-card]', { hasText: '已通过并映射到现有分类' }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // 默认 pending 列表自行刷新（禁止 page.reload）：application-row-<id> 消失（已转 approved）。
    await expect(page.getByTestId(`application-row-${mapReviewApplicationId}`)).toHaveCount(0, { timeout: 10_000 })

    // 切 admin-application-status-filter=approved 回查同 row：data-status=approved，
    // resolution 显示「映射现有分类」且包含 #approvedCategoryId。
    await page.getByTestId('admin-application-status-filter').selectOption('approved')
    const approvedMapRow = page.getByTestId(`application-row-${mapReviewApplicationId}`)
    await expect(approvedMapRow).toBeVisible({ timeout: 10_000 })
    await expect(approvedMapRow).toHaveAttribute('data-status', 'approved')
    await expect(page.getByTestId(`application-resolution-${mapReviewApplicationId}`)).toContainText('映射现有分类')
    await expect(page.getByTestId(`application-resolution-${mapReviewApplicationId}`)).toContainText(`#${approvedCategoryId}`)

    // 本卡为 map_existing 审核：不新建分类，故绝不检查 MAP_REVIEW_CODE 分类是否存在。
  })

  test('prepares a pending application for the later admin reject review (reject prep)', async ({ page }) => {
    // reject 数据准备：独立登录 + 进入 /merchant 分类申请面板。
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByRole('button', { name: '分类申请' }).click()
    await expect(page.getByTestId('category-application-panel')).toBeVisible({ timeout: 10_000 })

    // 打开真实创建表单，填唯一 REJECT_REVIEW_LABEL / 合法 lower-case REJECT_REVIEW_CODE /
    // ≥20 字 REJECT_REVIEW_DESCRIPTION + 合法示例商品。
    await page.getByTestId('merchant-application-create').click()
    await expect(page.getByTestId('application-form-label')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('application-form-label').fill(REJECT_REVIEW_LABEL)
    await page.getByTestId('application-form-code').fill(REJECT_REVIEW_CODE)
    await page.getByTestId('application-form-description').fill(REJECT_REVIEW_DESCRIPTION)
    await page.getByTestId('application-form-example').fill(EXAMPLE_PRODUCTS)

    // 点击真实提交动作前监听精确 pathname + POST。
    const rejectReviewCreateResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/merchant/category-applications'
      && response.request().method() === 'POST'
    )
    await page.getByTestId('application-form-submit').click()
    const rejectReviewCreateResult = await rejectReviewCreateResponse

    // 真实契约（server applicationRoutes.test.ts）：POST create → 201。
    expect(rejectReviewCreateResult.status()).toBe(201)

    // 严格类型守卫：从 unknown JSON 断言正整数 id、精确 label/code、status=pending，
    // 保存 rejectReviewApplicationId（禁止 any/as any）。
    const rejectReviewBody: unknown = await rejectReviewCreateResult.json()
    const rejectReviewCreated = parseApplication(rejectReviewBody, { label: REJECT_REVIEW_LABEL, code: REJECT_REVIEW_CODE })
    rejectReviewApplicationId = rejectReviewCreated.id
    expect(rejectReviewCreated.label).toBe(REJECT_REVIEW_LABEL)
    expect(rejectReviewCreated.code).toBe(REJECT_REVIEW_CODE)
    expect(rejectReviewCreated.status).toBe('pending')
    expect(rejectReviewApplicationId).toBeGreaterThan(0)

    // 请求 JSON：精确四 allowlist 字段，明确无 merchantId/status（复用既有 readCreatePayload，
    // 未弱化任何断言）。
    const rejectReviewRequestBody: unknown = rejectReviewCreateResult.request().postDataJSON()
    expect(readCreatePayload(rejectReviewRequestBody)).toEqual({
      proposedLabel: REJECT_REVIEW_LABEL,
      proposedCode: REJECT_REVIEW_CODE,
      description: REJECT_REVIEW_DESCRIPTION,
      exampleProducts: EXAMPLE_PRODUCTS,
    })

    // toast 成功 + 列表行 data-status=pending。
    await expect(
      page.locator('[data-toast-card]', { hasText: '分类申请已提交，等待平台审核' }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(`application-row-${rejectReviewApplicationId}`)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId(`application-row-${rejectReviewApplicationId}`)).toHaveAttribute('data-status', 'pending')

    // 本卡仅为后续 admin reject 审核准备 pending 数据：绝不 withdraw 该申请。
  })

  test('admin rejects the prepared application with a required review reason (D-CAT-10/D-CAT-11)', async ({ page }) => {
    // 串行依赖：第 8 个 pending 数据准备用例必须已保存正整数 rejectReviewApplicationId。
    expect(rejectReviewApplicationId).toBeGreaterThan(0)

    // 真实 admin MFA 登录（loginAs admin 走 seed TOTP 验证）→ /admin → 「目录治理」。
    await loginAs(page, SEED_ACCOUNTS.admin)
    await page.goto('/admin')
    await page.getByRole('button', { name: '目录治理' }).click()
    await expect(page.getByTestId('admin-category-manager')).toBeVisible({ timeout: 10_000 })

    // 显式断言状态筛选当前 value = 'pending'（组件默认值，非 UI 猜测），再按
    // application-row-<id> 精准定位本卡准备的行，断言 pending 后点击
    // application-reject-<id> 打开 reject 审核 dialog。
    await expect(page.getByTestId('admin-application-status-filter')).toHaveValue('pending')
    const row = page.getByTestId(`application-row-${rejectReviewApplicationId}`)
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(row).toHaveAttribute('data-status', 'pending')
    await page.getByTestId(`application-reject-${rejectReviewApplicationId}`).click()

    // reject dialog：断言标题「拒绝申请」及申请名称（REJECT_REVIEW_LABEL）。
    const rejectDialog = page.getByRole('dialog')
    await expect(rejectDialog).toBeVisible({ timeout: 10_000 })
    await expect(rejectDialog).toContainText('拒绝申请')
    await expect(rejectDialog).toContainText(REJECT_REVIEW_LABEL)

    // reason 留空点击 review-submit：必须断言「审核理由不能为空」，dialog 保持，且没有
    // 发出该 id 的 reject 请求。实现必须稳定（禁止 fixed sleep）：用 page request 事件
    // 计数/数组，仅统计精确 pathname+POST。
    const rejectRequests: string[] = []
    page.on('request', (request) => {
      if (request.method() !== 'POST') return
      const url = new URL(request.url())
      if (url.pathname === `/api/admin/category-applications/${rejectReviewApplicationId}/reject`) {
        rejectRequests.push(request.url())
      }
    })
    await rejectDialog.getByTestId('review-submit').click()
    await expect(rejectDialog.getByText('审核理由不能为空', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(rejectDialog).toBeVisible()
    await expect(rejectDialog.getByTestId('review-reason')).toBeVisible()
    expect(rejectRequests).toHaveLength(0)

    // 填固定合法 reason（1..500 字、无控制字符）；点击前 waitForResponse 精确 POST reject。
    await rejectDialog.getByTestId('review-reason').fill(REJECT_REVIEW_REASON)
    const rejectResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/admin/category-applications/${rejectReviewApplicationId}/reject`
      && response.request().method() === 'POST'
    )
    await rejectDialog.getByTestId('review-submit').click()
    const rejectResult = await rejectResponse

    // 真实契约（server applicationAdminRoutes.ts）：POST reject → 200。
    expect(rejectResult.status()).toBe(200)

    // 严格类型守卫：从 unknown JSON 证明 id 相同、status=rejected、resolution=null、
    // approvedCategoryId=null、reviewReason 精确，且响应键命中冻结 DTO allowlist
    // （拒绝任何额外键、显式点名内部/操作者字段）。
    const rejectBody: unknown = await rejectResult.json()
    const rejected = parseRejectedApplication(rejectBody, { id: rejectReviewApplicationId, reviewReason: REJECT_REVIEW_REASON })
    expect(rejected.id).toBe(rejectReviewApplicationId)
    expect(rejected.status).toBe('rejected')
    expect(rejected.resolution).toBeNull()
    expect(rejected.approvedCategoryId).toBeNull()
    expect(rejected.reviewReason).toBe(REJECT_REVIEW_REASON)

    // 请求 body 类型守卫：精确一键 { reviewReason }，拒绝任何额外键（禁止 any/as any）。
    const rejectRequestBody: unknown = rejectResult.request().postDataJSON()
    expect(readRejectPayload(rejectRequestBody)).toEqual({ reviewReason: REJECT_REVIEW_REASON })

    // 全程仅发出一次该 id 的 reject 请求（空理由那次未发出任何请求）。
    expect(rejectRequests).toHaveLength(1)

    // toast「已拒绝该申请」+ review dialog 关闭（Radix unmount 后 role=dialog 消失）。
    await expect(
      page.locator('[data-toast-card]', { hasText: '已拒绝该申请' }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // 默认 pending 列表自行刷新（禁止 page.reload）：application-row-<id> 消失（已转 rejected）。
    await expect(page.getByTestId(`application-row-${rejectReviewApplicationId}`)).toHaveCount(0, { timeout: 10_000 })

    // 切 admin-application-status-filter=rejected 回查同 row：data-status=rejected，
    // 显示 reviewReason、「已处理」，且不显示 approve/reject 操作按钮。
    await page.getByTestId('admin-application-status-filter').selectOption('rejected')
    const rejectedRow = page.getByTestId(`application-row-${rejectReviewApplicationId}`)
    await expect(rejectedRow).toBeVisible({ timeout: 10_000 })
    await expect(rejectedRow).toHaveAttribute('data-status', 'rejected')
    await expect(rejectedRow).toContainText(REJECT_REVIEW_REASON)
    await expect(rejectedRow).toContainText('已处理')
    await expect(page.getByTestId(`application-approve-new-${rejectReviewApplicationId}`)).toHaveCount(0)
    await expect(page.getByTestId(`application-approve-map-${rejectReviewApplicationId}`)).toHaveCount(0)
    await expect(page.getByTestId(`application-reject-${rejectReviewApplicationId}`)).toHaveCount(0)
  })

  test('merchant withdraws a pending application while the admin stale review dialog is open → 409 CATEGORY_APPLICATION_ALREADY_REVIEWED (D-CAT-10/AC-CAT-012)', async ({ page, browser }) => {
    // 本用例较其他用例多一个隔离 admin context + 一次 MFA 登录，放宽单测超时（非 sleep）。
    test.setTimeout(60_000)

    // ── 1) merchant page：真实表单创建唯一 pending（本用例自身完成「创建 + 竞态」）。
    await loginAs(page, SEED_ACCOUNTS.merchant)
    await page.goto('/merchant')
    await page.getByRole('button', { name: '分类申请' }).click()
    await expect(page.getByTestId('category-application-panel')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('merchant-application-create').click()
    await expect(page.getByTestId('application-form-label')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('application-form-label').fill(RACE_LABEL)
    await page.getByTestId('application-form-code').fill(RACE_CODE)
    await page.getByTestId('application-form-description').fill(RACE_DESCRIPTION)
    await page.getByTestId('application-form-example').fill(EXAMPLE_PRODUCTS)

    // 点击真实提交动作前监听精确 pathname + POST。
    const raceCreateResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/merchant/category-applications'
      && response.request().method() === 'POST'
    )
    await page.getByTestId('application-form-submit').click()
    const raceCreateResult = await raceCreateResponse
    expect(raceCreateResult.status()).toBe(201)

    // 严格类型守卫从 unknown JSON 解析，保存局部正整数 raceApplicationId。
    const raceCreateBody: unknown = await raceCreateResult.json()
    const raceCreated = parseApplication(raceCreateBody, { label: RACE_LABEL, code: RACE_CODE })
    const raceApplicationId = raceCreated.id
    expect(raceApplicationId).toBeGreaterThan(0)
    expect(raceCreated.label).toBe(RACE_LABEL)
    expect(raceCreated.code).toBe(RACE_CODE)
    expect(raceCreated.status).toBe('pending')

    // 请求 JSON：精确四 allowlist 字段，明确无 merchantId/status（复用既有 readCreatePayload）。
    const raceCreateRequestBody: unknown = raceCreateResult.request().postDataJSON()
    expect(readCreatePayload(raceCreateRequestBody)).toEqual({
      proposedLabel: RACE_LABEL,
      proposedCode: RACE_CODE,
      description: RACE_DESCRIPTION,
      exampleProducts: EXAMPLE_PRODUCTS,
    })

    // toast 成功 + 列表行 data-status=pending。
    await expect(
      page.locator('[data-toast-card]', { hasText: '分类申请已提交，等待平台审核' }),
    ).toBeVisible({ timeout: 10_000 })
    const raceMerchantRow = page.getByTestId(`application-row-${raceApplicationId}`)
    await expect(raceMerchantRow).toBeVisible({ timeout: 10_000 })
    await expect(raceMerchantRow).toHaveAttribute('data-status', 'pending')

    // ── 2) 隔离 admin context：baseURL 必须为 string（否则显式 throw），
    //    browser.newContext({ baseURL }) 创建独立 cookie/localStorage 会话。
    const baseURL = test.info().project.use.baseURL
    if (typeof baseURL !== 'string' || baseURL.length === 0) {
      throw new Error('project.use.baseURL 必须是 string（隔离 admin context 依赖 baseURL）')
    }
    const adminContext = await browser.newContext({ baseURL })
    try {
      const adminPage = await adminContext.newPage()

      // ── 3) adminPage：真实 admin MFA 登录 → /admin → 目录治理，打开 stale create_new dialog。
      await loginAs(adminPage, SEED_ACCOUNTS.admin)
      await adminPage.goto('/admin')
      await adminPage.getByRole('button', { name: '目录治理' }).click()
      await expect(adminPage.getByTestId('admin-category-manager')).toBeVisible({ timeout: 10_000 })
      await expect(adminPage.getByTestId('admin-application-status-filter')).toHaveValue('pending')
      const adminRaceRow = adminPage.getByTestId(`application-row-${raceApplicationId}`)
      await expect(adminRaceRow).toBeVisible({ timeout: 10_000 })
      await expect(adminRaceRow).toHaveAttribute('data-status', 'pending')
      await adminPage.getByTestId(`application-approve-new-${raceApplicationId}`).click()

      // stale dialog：断言预填（code/label/description），填 icon + reason，保持打开不提交。
      const staleReviewDialog = adminPage.getByRole('dialog')
      await expect(staleReviewDialog).toBeVisible({ timeout: 10_000 })
      await expect(staleReviewDialog.getByTestId('review-code')).toHaveValue(RACE_CODE)
      await expect(staleReviewDialog.getByTestId('review-label')).toHaveValue(RACE_LABEL)
      await expect(staleReviewDialog.getByTestId('review-description')).toHaveValue(RACE_DESCRIPTION)
      await staleReviewDialog.getByTestId('review-icon').fill('folder-tree')
      await staleReviewDialog.getByTestId('review-reason').fill(RACE_REASON)

      // ── 4) 回 merchant page：对同一 pending 点击 withdraw → 真实 confirm dialog 确认。
      const merchantRow = page.getByTestId(`application-row-${raceApplicationId}`)
      await expect(merchantRow).toBeVisible({ timeout: 10_000 })
      await expect(merchantRow).toHaveAttribute('data-status', 'pending')
      const withdrawButton = page.getByTestId(`application-withdraw-${raceApplicationId}`)
      await expect(withdrawButton).toBeVisible()
      await withdrawButton.click()
      const confirmDialog = page.getByRole('dialog')
      await expect(confirmDialog).toBeVisible({ timeout: 10_000 })
      await expect(confirmDialog).toContainText('撤回分类申请')
      await expect(confirmDialog).toContainText('确定撤回')
      const withdrawResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/merchant/category-applications/${raceApplicationId}/withdraw`
        && response.request().method() === 'POST'
      )
      await confirmDialog.getByRole('button', { name: '撤回', exact: true }).click()
      const withdrawResult = await withdrawResponse
      expect(withdrawResult.status()).toBe(200)

      // 复用 parseWithdrawnApplication 严格解析撤回结果。
      const withdrawBody: unknown = await withdrawResult.json()
      const withdrawn = parseWithdrawnApplication(withdrawBody, raceApplicationId)
      expect(withdrawn.id).toBe(raceApplicationId)
      expect(withdrawn.status).toBe('withdrawn')
      await expect(
        page.locator('[data-toast-card]', { hasText: '申请已撤回' }),
      ).toBeVisible({ timeout: 10_000 })
      await expect(merchantRow).toHaveAttribute('data-status', 'withdrawn', { timeout: 10_000 })
      await expect(page.getByTestId(`application-withdraw-${raceApplicationId}`)).toHaveCount(0)

      // ── 5) admin stale dialog 仍打开 → 点 submit：点击前精确 waitForResponse POST /approve。
      await expect(staleReviewDialog).toBeVisible()
      const approveResponse = adminPage.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/admin/category-applications/${raceApplicationId}/approve`
        && response.request().method() === 'POST'
      )
      await staleReviewDialog.getByTestId('review-submit').click()
      const approveResult = await approveResponse

      // 真实契约（server applicationRoutes.test.ts「second review returns 409」）：
      // withdraw 后 CAS 命中失败 → 409 CATEGORY_APPLICATION_ALREADY_REVIEWED，绝不能被伪造成成功。
      expect(approveResult.status()).toBe(409)
      const approveBody: unknown = await approveResult.json()
      expect(readErrorCode(approveBody)).toBe('CATEGORY_APPLICATION_ALREADY_REVIEWED')

      // 请求 body 用现有 readApproveCreateNewPayload 严格断言精确 create_new payload。
      const approveRequestBody: unknown = approveResult.request().postDataJSON()
      expect(readApproveCreateNewPayload(approveRequestBody)).toEqual({
        resolution: 'create_new',
        category: {
          code: RACE_CODE,
          label: RACE_LABEL,
          description: RACE_DESCRIPTION,
          iconKey: 'folder-tree',
        },
        reviewReason: RACE_REASON,
      })

      // ── 6) admin UI 稳定冲突 UX（组件冲突路径 refreshApplications）。
      await expect(
        adminPage.locator('[data-toast-card]', { hasText: '该申请已被审核或已撤回，无法重复操作' }),
      ).toBeVisible({ timeout: 10_000 })
      await expect(adminPage.getByRole('dialog')).toHaveCount(0)
      // 默认 pending 列表自行刷新：同 row 消失（已 withdrawn，不再命中 pending）。
      await expect(adminPage.getByTestId(`application-row-${raceApplicationId}`)).toHaveCount(0, { timeout: 10_000 })
      // 409 冲突路径绝不出现成功 toast「已通过并新建分类」。
      await expect(
        adminPage.locator('[data-toast-card]', { hasText: '已通过并新建分类' }),
      ).toHaveCount(0)

      // 切 withdrawn 状态回查同 row：data-status=withdrawn、显示「已处理」、无操作按钮。
      await adminPage.getByTestId('admin-application-status-filter').selectOption('withdrawn')
      const withdrawnAdminRow = adminPage.getByTestId(`application-row-${raceApplicationId}`)
      await expect(withdrawnAdminRow).toBeVisible({ timeout: 10_000 })
      await expect(withdrawnAdminRow).toHaveAttribute('data-status', 'withdrawn')
      await expect(withdrawnAdminRow).toContainText('已处理')
      await expect(adminPage.getByTestId(`application-approve-new-${raceApplicationId}`)).toHaveCount(0)
      await expect(adminPage.getByTestId(`application-approve-map-${raceApplicationId}`)).toHaveCount(0)
      await expect(adminPage.getByTestId(`application-reject-${raceApplicationId}`)).toHaveCount(0)

      // ── 7) 409 不被伪造成成功：不通过、不新建分类，故绝不断言任何新分类产生。
    } finally {
      await adminContext.close()
    }
  })

  test('admin creates and edits a category in the repository via the real UI (D-CAT-06)', async ({ page }) => {
    // 串行依赖：本用例自足（create + edit），无前置数据；categoryId 由 create 响应解析后保存。

    // 真实 admin MFA 登录（loginAs admin 走 seed TOTP 验证）→ /admin → 「目录治理」。
    await loginAs(page, SEED_ACCOUNTS.admin)
    await page.goto('/admin')
    await page.getByRole('button', { name: '目录治理' }).click()
    await expect(page.getByTestId('admin-category-manager')).toBeVisible({ timeout: 10_000 })

    // a. 断言默认 category filter = 全部（admin-category-status-filter value ''）。
    await expect(page.getByTestId('admin-category-status-filter')).toHaveValue('')

    // b. admin-category-create 打开「新建分类」dialog。
    await page.getByTestId('admin-category-create').click()
    const createDialog = page.getByRole('dialog')
    await expect(createDialog).toBeVisible({ timeout: 10_000 })
    await expect(createDialog).toContainText('新建分类')

    // 空 code 点击 submit：本地校验「分类编码不能为空」；page request 事件精确计数证明零请求（禁 sleep）。
    const createRequests: string[] = []
    page.on('request', (request) => {
      if (request.method() !== 'POST') return
      const url = new URL(request.url())
      if (url.pathname === '/api/admin/product-categories') {
        createRequests.push(request.url())
      }
    })
    await createDialog.getByTestId('category-form-submit').click()
    await expect(createDialog.getByText('分类编码不能为空', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(createDialog).toBeVisible()
    expect(createRequests).toHaveLength(0)

    // 填唯一合法 lower-case code / 唯一 label / description / kebab iconKey /
    // 合法平台资源 defaultCoverUrl（/assets/…）/ sortOrder 整数。
    await createDialog.getByTestId('category-form-code').fill(ADMIN_CATEGORY_CODE)
    await createDialog.getByTestId('category-form-label').fill(ADMIN_CATEGORY_LABEL)
    await createDialog.getByTestId('category-form-description').fill(ADMIN_CATEGORY_DESCRIPTION)
    await createDialog.getByTestId('category-form-icon').fill(ADMIN_CATEGORY_ICON)
    await createDialog.getByTestId('category-form-sort').fill(String(ADMIN_CATEGORY_SORT))
    await createDialog.getByTestId('category-form-cover').fill(ADMIN_CATEGORY_COVER)

    // c. 点击前精确 waitForResponse POST /api/admin/product-categories → 201；
    //    同时监听随后 create 成功触发的列表刷新 GET（page=1&pageSize=10、status 空），
    //    用于从真实响应解析 total/page/pageSize 计算 totalPages 并导航到末页。
    const createResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/admin/product-categories'
      && response.request().method() === 'POST'
    )
    const afterCreateListResponse = page.waitForResponse(isCategoryRepositoryListPage(1))
    await createDialog.getByTestId('category-form-submit').click()
    const createResult = await createResponse
    expect(createResult.status()).toBe(201)

    // create request unknown JSON 类型守卫严格精确六键，无 status/createdByUserId/操作者 ID。
    const createRequestBody: unknown = createResult.request().postDataJSON()
    expect(readCreateCategoryPayload(createRequestBody)).toEqual({
      code: ADMIN_CATEGORY_CODE,
      label: ADMIN_CATEGORY_LABEL,
      description: ADMIN_CATEGORY_DESCRIPTION,
      iconKey: ADMIN_CATEGORY_ICON,
      defaultCoverUrl: ADMIN_CATEGORY_COVER,
      sortOrder: ADMIN_CATEGORY_SORT,
    })

    // create response 用严格 CategoryAdminDto parser/allowlist 解析（id/creator/updater 正整数、
    // status active、提交字段精确、normalizedLabel trim lowercase、ISO 时间戳），保存正整数 categoryId。
    const createBody: unknown = await createResult.json()
    const created = parseCategoryAdminDto(createBody, {
      code: ADMIN_CATEGORY_CODE,
      label: ADMIN_CATEGORY_LABEL,
      description: ADMIN_CATEGORY_DESCRIPTION,
      iconKey: ADMIN_CATEGORY_ICON,
      defaultCoverUrl: ADMIN_CATEGORY_COVER,
      sortOrder: ADMIN_CATEGORY_SORT,
      status: 'active',
    })
    categoryId = created.id
    expect(categoryId).toBeGreaterThan(0)
    expect(created.status).toBe('active')

    // d. toast「分类已创建」+ dialog 关闭 + 列表自行刷新（禁止 page.reload）：
    //    刷新 GET 必须 status 200；从 unknown 严格解析 total/page/pageSize 计算
    //    totalPages。先看当前第一页；未找到时用 admin-category-pagination 内
    //    aria-label「下一页」真实逐页导航（每次点击前监听精确对应 page GET，每 GET
    //    status 200 且页参数精确）定位新建行——不假定其必在末页；每页响应后用 UI
    //    页码断言同步，再 row.isVisible() 判断，杜绝响应到达而 DOM 未更新的竞态。
    await expect(
      page.locator('[data-toast-card]', { hasText: '分类已创建' }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const afterCreateListResult = await afterCreateListResponse
    expect(afterCreateListResult.status()).toBe(200)
    const afterCreateListBody: unknown = await afterCreateListResult.json()
    const afterCreatePageInfo = readCategoryListPageInfo(afterCreateListBody)
    expect(afterCreatePageInfo.page).toBe(1)
    expect(afterCreatePageInfo.pageSize).toBe(10)
    const totalPages = Math.max(1, Math.ceil(afterCreatePageInfo.total / afterCreatePageInfo.pageSize))
    const categoryPagination = page.getByTestId('admin-category-pagination')
    let currentCategoryPage = 1
    const row = page.getByTestId(`category-row-${categoryId}`)
    await expect(categoryPagination).toContainText(`第 1 /`)
    let rowFound = await row.isVisible()
    for (let targetPage = 2; !rowFound && targetPage <= totalPages; targetPage++) {
      const pageResponse = page.waitForResponse(isCategoryRepositoryListPage(targetPage))
      await categoryPagination.getByRole('button', { name: '下一页' }).click()
      const pageResult = await pageResponse
      expect(pageResult.status()).toBe(200)
      const pageBody: unknown = await pageResult.json()
      const pageInfo = readCategoryListPageInfo(pageBody)
      expect(pageInfo.page).toBe(targetPage)
      expect(pageInfo.pageSize).toBe(10)
      currentCategoryPage = targetPage
      // 响应已到达但 React 可能尚未重渲染当前页：先用 UI 页码断言同步，再判断行可见。
      await expect(categoryPagination).toContainText(`第 ${targetPage} /`)
      rowFound = await row.isVisible()
    }
    expect(await row.isVisible(), '创建的分类在所有真实分页中均未找到').toBe(true)
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(row).toHaveAttribute('data-status', 'active')
    await expect(row).toContainText(ADMIN_CATEGORY_CODE)
    await expect(row).toContainText(ADMIN_CATEGORY_LABEL)
    await expect(row).toContainText(ADMIN_CATEGORY_DESCRIPTION)
    await expect(row.locator('td').nth(3)).toHaveText(String(ADMIN_CATEGORY_SORT))

    // e. category-edit-<id> 打开「编辑分类」，完整字段回填；code disabled + D-CAT-06 文案。
    await page.getByTestId(`category-edit-${categoryId}`).click()
    const editDialog = page.getByRole('dialog')
    await expect(editDialog).toBeVisible({ timeout: 10_000 })
    await expect(editDialog).toContainText('编辑分类')
    await expect(editDialog.getByTestId('category-form-code')).toHaveValue(ADMIN_CATEGORY_CODE)
    await expect(editDialog.getByTestId('category-form-code')).toBeDisabled()
    await expect(editDialog.getByTestId('category-form-label')).toHaveValue(ADMIN_CATEGORY_LABEL)
    await expect(editDialog.getByTestId('category-form-description')).toHaveValue(ADMIN_CATEGORY_DESCRIPTION)
    await expect(editDialog.getByTestId('category-form-icon')).toHaveValue(ADMIN_CATEGORY_ICON)
    await expect(editDialog.getByTestId('category-form-sort')).toHaveValue(String(ADMIN_CATEGORY_SORT))
    await expect(editDialog.getByTestId('category-form-cover')).toHaveValue(ADMIN_CATEGORY_COVER)
    await expect(editDialog).toContainText('编码创建后不可修改（D-CAT-06）。')

    // f. 修改 label/description/icon/defaultCover/sortOrder 为 *_EDIT 常量。
    await editDialog.getByTestId('category-form-label').fill(ADMIN_CATEGORY_LABEL_EDIT)
    await editDialog.getByTestId('category-form-description').fill(ADMIN_CATEGORY_DESCRIPTION_EDIT)
    await editDialog.getByTestId('category-form-icon').fill(ADMIN_CATEGORY_ICON_EDIT)
    await editDialog.getByTestId('category-form-sort').fill(String(ADMIN_CATEGORY_SORT_EDIT))
    await editDialog.getByTestId('category-form-cover').fill(ADMIN_CATEGORY_COVER_EDIT)

    // 点击前精确 waitForResponse PATCH /api/admin/product-categories/:id → 200；
    //    同时监听随后 edit 成功触发的列表刷新 GET（停在 currentCategoryPage：
    //    page=currentCategoryPage&pageSize=10、status 空），随后再真实「下一页」
    //    逐页导航到末页后断言更新后的行。
    const updateResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/admin/product-categories/${categoryId}`
      && response.request().method() === 'PATCH'
    )
    const afterEditListResponse = page.waitForResponse(isCategoryRepositoryListPage(currentCategoryPage))
    await editDialog.getByTestId('category-form-submit').click()
    const updateResult = await updateResponse
    expect(updateResult.status()).toBe(200)

    // edit request 严格精确五键 {label,description,iconKey,defaultCoverUrl,sortOrder}，绝无 code/status/操作者 ID。
    const updateRequestBody: unknown = updateResult.request().postDataJSON()
    expect(readUpdateCategoryPayload(updateRequestBody)).toEqual({
      label: ADMIN_CATEGORY_LABEL_EDIT,
      description: ADMIN_CATEGORY_DESCRIPTION_EDIT,
      iconKey: ADMIN_CATEGORY_ICON_EDIT,
      defaultCoverUrl: ADMIN_CATEGORY_COVER_EDIT,
      sortOrder: ADMIN_CATEGORY_SORT_EDIT,
    })

    // edit response 复用同一严格 parser：id/code 不变、所有修改值精确、active。
    const updateBody: unknown = await updateResult.json()
    const updated = parseCategoryAdminDto(updateBody, {
      code: ADMIN_CATEGORY_CODE,
      label: ADMIN_CATEGORY_LABEL_EDIT,
      description: ADMIN_CATEGORY_DESCRIPTION_EDIT,
      iconKey: ADMIN_CATEGORY_ICON_EDIT,
      defaultCoverUrl: ADMIN_CATEGORY_COVER_EDIT,
      sortOrder: ADMIN_CATEGORY_SORT_EDIT,
      status: 'active',
    })
    expect(updated.id).toBe(categoryId)
    expect(updated.code).toBe(ADMIN_CATEGORY_CODE)
    expect(updated.status).toBe('active')

    // g. toast「分类已更新」+ dialog 关闭 + 编辑后列表刷新停在 currentCategoryPage
    //    status 200 且页参数精确；随后用真实「下一页」逐页导航到 totalPages 末页，
    //    same row 在末页仍显示新 label/description/sortOrder、旧 label 不再显示、
    //    edit button aria-label 更新；create 精确 request 事件总数应 1。
    await expect(
      page.locator('[data-toast-card]', { hasText: '分类已更新' }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const afterEditListResult = await afterEditListResponse
    expect(afterEditListResult.status()).toBe(200)
    const afterEditListBody: unknown = await afterEditListResult.json()
    const afterEditPageInfo = readCategoryListPageInfo(afterEditListBody)
    expect(afterEditPageInfo.page).toBe(currentCategoryPage)
    expect(afterEditPageInfo.pageSize).toBe(10)
    for (let targetPage = currentCategoryPage + 1; targetPage <= totalPages; targetPage++) {
      const pageResponse = page.waitForResponse(isCategoryRepositoryListPage(targetPage))
      await categoryPagination.getByRole('button', { name: '下一页' }).click()
      const pageResult = await pageResponse
      expect(pageResult.status()).toBe(200)
      const pageBody: unknown = await pageResult.json()
      const pageInfo = readCategoryListPageInfo(pageBody)
      expect(pageInfo.page).toBe(targetPage)
      expect(pageInfo.pageSize).toBe(10)
      await expect(categoryPagination).toContainText(`第 ${targetPage} /`)
    }
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(row).toContainText(ADMIN_CATEGORY_LABEL_EDIT, { timeout: 10_000 })
    await expect(row).toContainText(ADMIN_CATEGORY_DESCRIPTION_EDIT)
    await expect(row.locator('td').nth(3)).toHaveText(String(ADMIN_CATEGORY_SORT_EDIT))
    await expect(row).toContainText(ADMIN_CATEGORY_CODE)
    await expect(row).not.toContainText(ADMIN_CATEGORY_LABEL)
    await expect(page.getByTestId(`category-edit-${categoryId}`)).toHaveAttribute(
      'aria-label',
      `编辑分类 ${ADMIN_CATEGORY_LABEL_EDIT}`,
    )
    expect(createRequests).toHaveLength(1)
  })
  test('admin deactivates the repository category via the real UI', async ({ page }) => {
    // 串行依赖：第 11 个 create/edit 用例必须已保存正整数 categoryId（复用其编辑后的
    // ADMIN_CATEGORY_CODE / ADMIN_CATEGORY_*_EDIT 常量，且该分类当前仍为 active）。
    expect(categoryId).toBeGreaterThan(0)

    // 真实 admin MFA 登录（loginAs admin 走 seed TOTP 验证）→ /admin。
    await loginAs(page, SEED_ACCOUNTS.admin)
    await page.goto('/admin')

    // 点击「目录治理」前先监听分类仓库列表初始 GET：精确 /api/admin/product-categories、
    // GET、page=1&pageSize=10、status 缺失/空（复用 isCategoryRepositoryListPage）。
    const initialCategoriesResponse = page.waitForResponse(isCategoryRepositoryListPage(1))
    await page.getByRole('button', { name: '目录治理' }).click()
    await expect(page.getByTestId('admin-category-manager')).toBeVisible({ timeout: 10_000 })

    // 从 unknown 严格解析 total/page/pageSize，计算 totalPages（真实 read network，禁止 any）。
    const initialCategoriesResult = await initialCategoriesResponse
    expect(initialCategoriesResult.status()).toBe(200)
    const initialBody: unknown = await initialCategoriesResult.json()
    const initialPageInfo = readCategoryListPageInfo(initialBody)
    expect(initialPageInfo.page).toBe(1)
    expect(initialPageInfo.pageSize).toBe(10)
    const totalPages = Math.max(1, Math.ceil(initialPageInfo.total / initialPageInfo.pageSize))

    // 默认 category filter = 全部（admin-category-status-filter value ''）。
    await expect(page.getByTestId('admin-category-status-filter')).toHaveValue('')

    // 用 admin-category-pagination「下一页」真实逐页走到末页；每次点击前监听精确对应 page
    // GET、status 200、页参数精确，并用 UI 页码断言同步（杜绝响应到达而 DOM 未更新竞态）。
    const categoryPagination = page.getByTestId('admin-category-pagination')
    await expect(categoryPagination).toContainText(`第 1 /`)
    for (let targetPage = 2; targetPage <= totalPages; targetPage++) {
      const pageResponse = page.waitForResponse(isCategoryRepositoryListPage(targetPage))
      await categoryPagination.getByRole('button', { name: '下一页' }).click()
      const pageResult = await pageResponse
      expect(pageResult.status()).toBe(200)
      const pageBody: unknown = await pageResult.json()
      const pageInfo = readCategoryListPageInfo(pageBody)
      expect(pageInfo.page).toBe(targetPage)
      expect(pageInfo.pageSize).toBe(10)
      await expect(categoryPagination).toContainText(`第 ${targetPage} /`)
    }

    // 定位上一用例已编辑且 active 的行（末页；sortOrder=1_000_000 保证落在末页）。
    const row = page.getByTestId(`category-row-${categoryId}`)
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(row).toHaveAttribute('data-status', 'active')
    await expect(row).toContainText(ADMIN_CATEGORY_CODE)
    await expect(row).toContainText(ADMIN_CATEGORY_LABEL_EDIT)

    // 从第一次点停用起统计精确 deactivate POST（禁 sleep：page request 事件精确计数）。
    const deactivateRequests: string[] = []
    page.on('request', (request) => {
      if (request.method() !== 'POST') return
      const url = new URL(request.url())
      if (url.pathname === `/api/admin/product-categories/${categoryId}/deactivate`) {
        deactivateRequests.push(request.url())
      }
    })

    // ── 第一次点停用：断言 ConfirmDialog 标题「停用分类」+ 历史已发布商品仍可显示的提示，
    //    点「取消」关闭并证明零 deactivate POST（列表不刷新、行仍 active）。
    const deactivateButton = page.getByTestId(`category-deactivate-${categoryId}`)
    await expect(deactivateButton).toBeVisible()
    await deactivateButton.click()
    const confirmDialog = page.getByRole('dialog')
    await expect(confirmDialog).toBeVisible({ timeout: 10_000 })
    await expect(confirmDialog).toContainText('停用分类')
    await expect(confirmDialog).toContainText('历史已发布商品仍可显示该分类，但新商品首次发布不能使用')
    await confirmDialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(confirmDialog).toHaveCount(0)
    await expect(row).toHaveAttribute('data-status', 'active')
    expect(deactivateRequests).toHaveLength(0)

    // ── 第二次点停用：点击 dialog 内精确「停用」按钮前，同时监听精确 deactivate POST 与
    //    末页列表 refresh GET（成功后 refreshCategories 停在当前末页）。
    await page.getByTestId(`category-deactivate-${categoryId}`).click()
    await expect(confirmDialog).toBeVisible({ timeout: 10_000 })
    const deactivateResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/admin/product-categories/${categoryId}/deactivate`
      && response.request().method() === 'POST'
    )
    const refreshResponse = page.waitForResponse(isCategoryRepositoryListPage(totalPages))
    await confirmDialog.getByRole('button', { name: '停用', exact: true }).click()
    const deactivateResult = await deactivateResponse

    // 真实契约（server categoryAdminRoutes.test.ts）：POST deactivate → 200。
    expect(deactivateResult.status()).toBe(200)

    // 请求体通过现有 isEmptyMutationPayload（停用为无 body 变更；无 any/as any）。
    const deactivateRequestBody: unknown = deactivateResult.request().postDataJSON()
    expect(isEmptyMutationPayload(deactivateRequestBody)).toBe(true)

    // 响应通过现有严格 parseCategoryAdminDto：status=inactive、id/code 不变、编辑后字段精确。
    const deactivateBody: unknown = await deactivateResult.json()
    const deactivated = parseCategoryAdminDto(deactivateBody, {
      code: ADMIN_CATEGORY_CODE,
      label: ADMIN_CATEGORY_LABEL_EDIT,
      description: ADMIN_CATEGORY_DESCRIPTION_EDIT,
      iconKey: ADMIN_CATEGORY_ICON_EDIT,
      defaultCoverUrl: ADMIN_CATEGORY_COVER_EDIT,
      sortOrder: ADMIN_CATEGORY_SORT_EDIT,
      status: 'inactive',
    })
    expect(deactivated.id).toBe(categoryId)
    expect(deactivated.code).toBe(ADMIN_CATEGORY_CODE)
    expect(deactivated.status).toBe('inactive')

    // 末页列表 refresh GET：status 200、page=末页、pageSize=10（参数精确）。
    const refreshResult = await refreshResponse
    expect(refreshResult.status()).toBe(200)
    const refreshBody: unknown = await refreshResult.json()
    const refreshPageInfo = readCategoryListPageInfo(refreshBody)
    expect(refreshPageInfo.page).toBe(totalPages)
    expect(refreshPageInfo.pageSize).toBe(10)

    // toast「分类已停用；历史商品仍可读取」+ dialog 关闭（Radix unmount 后 role=dialog 消失）。
    await expect(
      page.locator('[data-toast-card]', { hasText: '分类已停用；历史商品仍可读取' }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // 列表自行刷新（禁止 page.reload）：同一行 data-status=inactive、
    // inactive-historical-label 文案精确、停用按钮消失、启用按钮出现。
    await expect(row).toHaveAttribute('data-status', 'inactive', { timeout: 10_000 })
    await expect(row.getByTestId('inactive-historical-label')).toHaveText(
      '历史分类（已发布商品仍显示，不可用于新商品首次发布）',
    )
    await expect(page.getByTestId(`category-deactivate-${categoryId}`)).toHaveCount(0)
    await expect(page.getByTestId(`category-activate-${categoryId}`)).toBeVisible()

    // 全程仅发出一次该 id 的 deactivate 请求（取消那次未发出任何请求）。
    expect(deactivateRequests).toHaveLength(1)
  })
})
