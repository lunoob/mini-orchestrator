# 测试反模式

**在以下情况阅读本文：** 编写或修改测试、添加 mock、或想给生产类加仅测试用的方法时。

## 概述

测试必须验证真实行为，而不是 mock 的行为。Mock 是用来隔离依赖的手段，不是被测对象。

**核心原则：** 测代码做了什么，不要测 mock 做了什么。

**严格的 TDD 能避免这些反模式。**

## 铁律

```
1. 绝不测试 mock 的行为
2. 绝不给生产类添加仅测试用的方法
3. 不理解依赖就不要 mock
```

## 反模式 1：测试 Mock 行为

**违规示例：**

```typescript
// ❌ 差：验证 mock 是否存在
test('渲染侧边栏', () => {
  render(<Page />);
  expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument();
});
```

**为什么错：**

- 验证的是 mock 能用，不是组件能用
- mock 在就过，不在就挂
- 对真实行为零信息

**纠正方向：** 「我们是在测 mock 的行为吗？」

**修复：**

```typescript
// ✅ 好：测真实组件，或不 mock 侧边栏
test('渲染侧边栏', () => {
  render(<Page />);
  expect(screen.getByRole('navigation')).toBeInTheDocument();
});

// 若必须为隔离而 mock 侧边栏：
// 不要断言 mock 本身——测 Page 在侧边栏存在时的行为
```

### 门禁

```
在断言任何 mock 元素之前：
  问：「我在测真实组件行为，还是只测 mock 存在？」

  若只是测 mock 存在：
    停——删掉该断言，或取消 mock

  改为测真实行为
```

## 反模式 2：生产代码中的测试专用方法

**违规示例：**

```typescript
// ❌ 差：destroy() 只在测试里用
class Session {
  async destroy() {  // 看起来像生产 API！
    await this._workspaceManager?.destroyWorkspace(this.id);
    // ... 清理
  }
}

// 测试中
afterEach(() => session.destroy());
```

**为什么错：**

- 生产类被测试代码污染
- 误在生产环境调用很危险
- 违反 YAGNI 和关注点分离
- 混淆对象生命周期与实体生命周期

**修复：**

```typescript
// ✅ 好：测试工具负责清理
// Session 没有 destroy()——生产里是无状态或自管理的

// test-utils/
export async function cleanupSession(session: Session) {
  const workspace = session.getWorkspaceInfo();
  if (workspace) {
    await workspaceManager.destroyWorkspace(workspace.id);
  }
}

// 测试中
afterEach(() => cleanupSession(session));
```

### 门禁

```
在给生产类加任何方法之前：
  问：「这只在测试里用吗？」

  若是：
    停——不要加
    放到 test utilities

  问：「这个类拥有该资源的生命周期吗？」

  若否：
    停——方法放错类了
```

## 反模式 3：不理解就 Mock

**违规示例：**

```typescript
// ❌ 差：Mock 破坏了测试依赖的逻辑
test('检测重复 server', () => {
  // Mock 阻止了测试依赖的配置写入！
  vi.mock('ToolCatalog', () => ({
    discoverAndCacheTools: vi.fn().mockResolvedValue(undefined)
  }));

  await addServer(config);
  await addServer(config);  // 应该抛错——但不会！
});
```

**为什么错：**

- 被 mock 的方法有测试依赖的副作用（写配置）
- 为「安全」过度 mock，破坏真实行为
- 测试因错误原因通过，或莫名失败

**修复：**

```typescript
// ✅ 好：在正确的层级 mock
test('检测重复 server', () => {
  // 只 mock 慢的部分，保留测试需要的行为
  vi.mock('MCPServerManager');

  await addServer(config);  // 配置已写入
  await addServer(config);  // 检测到重复 ✓
});
```

### 门禁

```
在 mock 任何方法之前：
  停——先不要 mock

  1. 问：「真实方法有哪些副作用？」
  2. 问：「这个测试依赖其中哪些副作用？」
  3. 问：「我是否清楚测试需要什么？」

  若依赖副作用：
    在更低层 mock（真正慢/外部的操作）
    或使用保留必要行为的 test double
    不要 mock 测试依赖的高层方法

  若不确定测试依赖什么：
    先用真实实现跑测试
    观察实际需要什么
    再在正确层级加最少 mock

  红旗：
    - 「mock 一下比较安全」
    - 「可能很慢，还是 mock 吧」
    - 不理解依赖链就 mock
```

## 反模式 4：不完整的 Mock

**违规示例：**

```typescript
// ❌ 差：部分 mock——只填你以为需要的字段
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' }
  // 缺少：下游代码使用的 metadata
};

// 之后：访问 response.metadata.requestId 时崩溃
```

**为什么错：**

- **部分 mock 隐藏结构假设**——只 mock 了你知道的字段
- **下游可能依赖你没包的字段**——静默失败
- **测试过、集成挂**——mock 不完整，真实 API 完整
- **虚假信心**——证明不了真实行为

**铁律：** Mock 的数据结构应与现实中完整一致，不要只 mock 当前测试立刻用到的字段。

**修复：**

```typescript
// ✅ 好：镜像真实 API 的完整性
const mockResponse = {
  status: 'success',
  data: { userId: '123', name: 'Alice' },
  metadata: { requestId: 'req-789', timestamp: 1234567890 }
  // 真实 API 返回的全部字段
};
```

### 门禁

```
在创建 mock 响应之前：
  检查：「真实 API 响应包含哪些字段？」

  动作：
    1. 查文档/示例中的真实响应
    2. 包含系统下游可能消费的全部字段
    3. 确认 mock 与真实 schema 完全一致

  关键：
    若要做 mock，必须理解完整结构
    部分 mock 会在代码依赖遗漏字段时静默失败

  不确定时：包含文档中的全部字段
```

## 反模式 5：集成测试当事后补救

**违规示例：**

```
✅ 实现完成
❌ 没写测试
「可以开始测试了」
```

**为什么错：**

- 测试是实现的一部分，不是可选收尾
- TDD 本可抓住这个问题
- 没有测试不能声称完成

**修复：**

```
TDD 循环：
1. 写失败测试
2. 实现到通过
3. 重构
4. 然后才声称完成
```

## Mock 过于复杂时

**警告信号：**

- Mock 搭建比测试逻辑还长
- 为了过测试什么都 mock
- Mock 缺少真实组件有的方法
- 改 mock 测试就挂

**自问：** 「这里真的需要 mock 吗？」

**考虑：** 用真实组件的集成测试，往往比复杂 mock 更简单。

## TDD 如何避免这些反模式

**原因：**

1. **先写测试** → 迫使你想清楚到底在测什么
2. **观察失败** → 确认测的是真实行为，不是 mock
3. **最少实现** → 测试专用方法不易渗入生产代码
4. **真实依赖** → 在 mock 前看清测试真正需要什么

**若你在测 mock 行为，说明违反了 TDD**——你在没有先对真实代码观察失败的情况下就加了 mock。

## 速查

| 反模式 | 修复 |
|--------|------|
| 断言 mock 元素 | 测真实组件，或取消 mock |
| 生产类中的测试专用方法 | 移到 test utilities |
| 不理解就 mock | 先理解依赖，最少 mock |
| 不完整 mock | 镜像真实 API 的完整结构 |
| 测试当事后补救 | TDD——测试先行 |
| Mock 过度复杂 | 考虑集成测试 |

## 红旗

- 断言检查 `*-mock` 的 test ID
- 方法只在测试文件里被调用
- Mock 搭建占测试一半以上
- 去掉 mock 测试就失败
- 说不清为什么需要这个 mock
- 「mock 一下比较安全」

## 底线

**Mock 是隔离工具，不是被测对象。**

若 TDD 暴露出你在测 mock 行为，说明走偏了。

修复：测真实行为，或重新思考是否真的需要 mock。
