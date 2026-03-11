## Context

`GetMapMatrixAsync`（`CapturePointManager.cs:348`）的核心工作是：根据起点/终点捕获点的 `RegPtType` 组合，从 VCM 数据或机器人记录数据中计算出坐标校准矩阵。当前方法体约 170 行，以嵌套 if/else 枚举所有场景。每新增识别场景（如新增传感器类型或混合模式）都需修改该方法，违反开闭原则。

Calculator 类需要访问 `CapturePointManager` 上的若干工具方法（`GetNormalFromVcm`、`GetPointFromVcm`、`CalcCoordinateMatrix`、`DetermineMasterAndSideNormals`、`FromRecord2Vec`、`IsPtRecorded`、`GetRecordedNormal`、`SetRecordPoseNormal`），这是设计的主要约束。

## Goals / Non-Goals

**Goals:**
- 将 `GetMapMatrixAsync` 中各场景分支提取为独立的 Calculator 类
- 新增场景只需新增 Calculator 类 + 注册映射，不修改已有代码
- 起终点法向量独立处理，支持基于 t 值的姿态变换插值
- 调用方通过 `IMapCalculator.CalcBy(t)` 按焊缝位置获取不同的精定位矩阵

**Non-Goals:**
- 不改变各场景中"位置如何获取"的逻辑（视觉识别/机器人记录）
- 不引入 DI 容器注册或运行时动态加载

## Decisions

### 1. 使用策略模式（Strategy Pattern），而非访问者模式或纯方法提取

`RegPtType` 组合决定"如何算"，天然适合策略模式。访问者模式需要双分派，适合对象结构遍历，此处过重。纯方法提取（`private CalcXxx`）无法解决方法体随场景线性增长的问题。

**选定**：Strategy Pattern，每个场景对应一个实现类。

---

### 2. 数据与行为分离：`MapMatrixData` + `IMapMatrixOps`

Calculator 的输入包含两类内容：

| 类别 | 性质 | 解决方案 |
|------|------|---------|
| VCM 数据、焊缝信息、捕获点 | 每次调用不同（per-call） | `MapMatrixData` record |
| 计算工具方法 | 固定来自 `CapturePointManager`（唯一实现） | `IMapMatrixOps` 接口 |

**演进过程**：初版使用 `IMapMatrixComputeContext` 混合数据与行为，通过 `MapMatrixComputeContext` 适配器（8 个委托参数构造函数）将 `CapturePointManager` 的私有方法转发给 Calculator。反思后发现适配器是唯一实现、无真实多态价值，遂拆分为数据 record + 行为接口，`CapturePointManager` 直接实现 `IMapMatrixOps`（显式接口实现），消除适配器类。

**最终结构**：
- `MapMatrixData` record：`Wsg`、`StCapturePt`、`EdCapturePt`、`StNewVcm`、`EdNewVcm`、`StOldVcm`、`EdOldVcm`
- `IMapMatrixOps` 接口：`GetNormalFromVcm`（单 VCM）、`GetPointFromVcm`、`CalcCoordinateMatrix`（6 参数）、`DetermineMasterAndSideNormals`、`FromRecord2Vec`、`IsPtRecorded`、`GetRecordedNormal`、`SetRecordPoseNormal`
- `CapturePointManager : IMapMatrixOps` 直接实现接口

Calculator 签名：`CalcAsync(MapMatrixData data, IMapMatrixOps ops, CancellationToken token): Task<IMapCalculator>`

---

### 3. t 值姿态变换插值：`IMapCalculator`

旧方案：`GetMapMatrixAsync` 返回单一 `Matrix4x4`，所有焊接路径点使用相同的校正矩阵。

新方案：返回 `IMapCalculator`，调用方通过 `CalcBy(t)` 获取对应位置（t∈[0,1]，0=起点，1=终点）的变换矩阵。

- `CalcBy(double t): Matrix4x4`：从起终点法向量构建旋转矩阵并提取四元数，使用 `Quaternion.Lerp`（nlerp，小角度变化下近似 SLERP）插值姿态，位置线性插值，重建坐标矩阵后左乘 `_leftMat`
- `Mul(Matrix4x4 lMat): void`：累积左乘矩阵（用于叠加旧坐标矩阵的逆）

`ApplyPrecisePositioningMatrix` 改为接受 `IMapCalculator`，按 `t = i / (N-1)` 对每个焊接路径点应用不同的校正矩阵。

---

### 4. 起终点法向量独立处理

旧方案：`GetNormalFromVcm(wsg, stVcm, edVcm)` 合并两端 VCM 的法向量取平均。

新方案：`GetNormalFromVcm(wsg, vcm)` 接受单个 VCM，分别调用获取各自的 `(masterNormal, sideNormal)`。`CalcCoordinateMatrix` 接受 6 个向量参数（起终点各自的主面法向量、侧面法向量、点位），返回 `IMapCalculator`。

只有一端有 VCM 数据的场景（如 RobotRecord），两端使用相同法向量（t 值插值时姿态不变）。

---

### 5. 用字典映射 `(RegPtType stType, RegPtType edType)` → `IMapCalculatable`，而非工厂 switch

字典注册方式在新增场景时只需追加一行，无需修改 switch 语句。`CapturePointManager` 内部的 `_calculators` 字典在构造时完成注册。

---

### 6. 文件组织：新建 `Scanning/MapMatrix/` 子目录

```
Scanning/MapMatrix/
  IMapMatrixCalculator.cs          // IMapCalculatable 策略接口 + IMapCalculator t值接口
  IMapMatrixOps.cs                 // 行为接口（CapturePointManager 实现）
  MapMatrixData.cs                 // 纯数据 record
  MapCaculator.cs                  // IMapCalculator 实现，t 值插值逻辑
  Calculators/
    BothVisionedCalculator.cs
    BothRobotRecordCalculator.cs
    StartRobotRecordCalculator.cs
    EndRobotRecordCalculator.cs
    BothRobotRecordVisionedCalculator.cs
    StartRobotRecordVisionedCalculator.cs
    EndRobotRecordVisionedCalculator.cs
```

`GetMapMatrixAsync` 精简后的结构：

```
1. 统一 await 预取全部 VCM 数据
2. 验证 RegType（UnRegnize/Vision → throw）
3. 计算旧坐标矩阵（4 参数私有方法，返回 Matrix4x4）
4. 从字典查找 Calculator
5. 构造 MapMatrixData，调用 calculator.CalcAsync(data, this, token) → IMapCalculator
6. 旧矩阵取逆后 Mul 到 IMapCalculator 中
7. 返回 IMapCalculator
```

## Risks / Trade-offs

- **`IMapMatrixOps` 方法列表可能随工具方法增加而膨胀** → 若出现此情况，可将方法按功能拆分为多个小接口（接口隔离），但当前不需要
- **`BothRobotRecordCalculator` 内部仍有 if/else**（起点有记录 vs 终点有记录）→ 这是该场景的内在逻辑分支，属于实现细节而非场景分支，不做进一步拆分
- **`GetNormalFromVcm` 单 VCM 版本使用 `idxInWsg=0` 判定板件顺序** → 如果起终点的板件排列不同，可能需要补充 `idxInWsg` 参数
- **t 值姿态插值使用四元数 nlerp（`Quaternion.Lerp`）** → 小角度变化下近似 SLERP，精度足够。若后续遇到大角度场景，可改用 `Quaternion.Slerp`

## Migration Plan

1. 新建 `Scanning/MapMatrix/` 目录及接口文件
2. 将各分支逻辑迁移至对应 Calculator 类，逐一验证
3. 替换 `GetMapMatrixAsync` 方法体
4. 删除旧分支代码
5. 更新 `ApplyPrecisePositioningMatrix` 接受 `IMapCalculator` 并按 t 值逐点应用
6. 无需数据库迁移或部署特殊步骤，回滚即恢复旧方法体

## Open Questions

（已解决）
- VCM 数据在 `GetMapMatrixAsync` 中统一预取后作为 `MapMatrixData` 传入 Calculator，Calculator 不发起 I/O
- `BothRobotRecordCalculator` 不拆分，内含两个子分支属于实现细节
- 中间适配器类已消除，改为 `CapturePointManager` 直接实现 `IMapMatrixOps`
- 返回类型由 `Matrix4x4` 变更为 `IMapCalculator`，调用方通过 `CalcBy(t)` 获取变换矩阵
