## Purpose

坐标矩阵计算的策略模式框架。将 `GetMapMatrixAsync` 中不同识别场景（`RegPtType` 组合）的分支逻辑提取为独立的 `IMapCalculatable` 实现类，通过字典注册选择策略，新增场景不修改已有代码。起点和终点的法向量独立处理，通过 `IMapCalculator` 接口支持基于 t 值的姿态变换插值。

## Requirements

### Requirement: 策略接口统一签名
系统 SHALL 定义 `IMapCalculatable` 接口，包含唯一方法 `CalcAsync(MapMatrixData data, IMapMatrixOps ops, CancellationToken token): Task<IMapCalculator>`，所有场景实现类 MUST 实现该接口。

#### Scenario: 调用策略计算坐标矩阵
- **WHEN** `GetMapMatrixAsync` 选定对应的 Calculator 实例并调用 `CalcAsync`
- **THEN** 返回该场景下的坐标计算器（`IMapCalculator`），支持基于 t 值的姿态变换

---

### Requirement: t 值姿态变换接口
系统 SHALL 定义 `IMapCalculator` 接口，提供基于 t 值（t∈[0,1]）的姿态变换能力：
- `CalcBy(double t): Matrix4x4`：根据 t 值在起点（t=0）和终点（t=1）之间插值，返回对应位置的变换矩阵。姿态部分使用四元数线性插值（nlerp），位置部分线性插值。
- `Mul(Matrix4x4 lMat): void`：左乘一个矩阵（用于叠加旧坐标矩阵的逆矩阵）

实现类 `MapCalculator` SHALL 在构造时从起终点法向量构建旋转矩阵并提取四元数，`CalcBy(t)` 通过 `Quaternion.Lerp` 插值姿态。坐标的平移补偿保持原有逻辑不变。

矩阵 MUST 遵循 `System.Numerics.Matrix4x4` 的行向量约定（`v * M`）：Row 1 = X 基向量（焊缝方向，非归一化），Row 2 = Y 基向量（侧面法向量），Row 3 = Z 基向量（主面法向量），Row 4 = 平移。`QuaternionFromAxes` 构建旋转矩阵时行=基向量，与 `Quaternion.CreateFromRotationMatrix` / `Matrix4x4.CreateFromQuaternion` 的行向量约定一致。`CalcBy(t)` 从插值后的旋转矩阵提取 Row 2（M21-M23）和 Row 3（M31-M33）作为 Y、Z 基向量。

> **注意**：`WeldPoseMapUtils.TransferPose` 中的注释"transfer 是列优先矩阵"具有误导性。`CalcBy(t)` 的输出使用 .NET 标准行向量约定。`TransferPose` 中的 `Transpose` 是将行向量约定转换为 MathNet Numerics 列向量约定以送入 SVD，属于跨库约定转换。

#### Scenario: 起点变换
- **WHEN** 调用 `CalcBy(0)`
- **THEN** 返回起点处的变换矩阵（使用起点法向量构建的坐标系）

#### Scenario: 终点变换
- **WHEN** 调用 `CalcBy(1)`
- **THEN** 返回终点处的变换矩阵（使用终点法向量构建的坐标系）

#### Scenario: 左乘旧坐标矩阵逆
- **WHEN** `GetMapMatrixAsync` 计算旧坐标矩阵的逆并调用 `Mul(oldInverse)`
- **THEN** 后续 `CalcBy(t)` 返回的矩阵包含该逆矩阵的效果

---

### Requirement: 起终点法向量独立处理
系统 SHALL 将起点和终点的法向量独立计算，不再合并平均。`IMapMatrixOps.GetNormalFromVcm(WeldSeamGroup wsg, VisionCapModel vcm)` 接受单个 VCM，返回该端点的主面和侧面法向量。`CalcCoordinateMatrix` 接受起终点各自的法向量（共 6 个向量参数），返回 `IMapCalculator`。

#### Scenario: 分别提取起终点法向量
- **WHEN** Calculator 调用 `ops.GetNormalFromVcm(wsg, stNewVcm)` 和 `ops.GetNormalFromVcm(wsg, edNewVcm)`
- **THEN** 分别返回起点和终点各自的 `(masterNormal, sideNormal)`，不做合并平均

#### Scenario: 使用分离的法向量构建坐标计算器
- **WHEN** Calculator 调用 `ops.CalcCoordinateMatrix(stMn, stSn, stPt, edMn, edSn, edPt)`
- **THEN** 返回 `IMapCalculator` 实例，内部保存起终点各自的法向量用于 t 值插值

---

### Requirement: 数据与行为分离
系统 SHALL 将 Calculator 所需的输入分为两部分：
- `MapMatrixData` record：纯数据，包含 `WeldSeamGroup Wsg`、`CapturePointInfo StCapturePt`、`CapturePointInfo EdCapturePt`、新旧 VCM 数据（`StNewVcm`、`EdNewVcm`、`StOldVcm`、`EdOldVcm`）
- `IMapMatrixOps` 接口：纯行为，提供工具方法 `GetNormalFromVcm`（单 VCM）、`GetPointFromVcm`、`CalcCoordinateMatrix`（6 参数）、`DetermineMasterAndSideNormals`、`FromRecord2Vec`、`IsPtRecorded`、`GetRecordedNormal`、`SetRecordPoseNormal`

VCM 数据（起点和终点，新旧共四份）MUST 在 `GetMapMatrixAsync` 中统一 await 预取后，作为 `MapMatrixData` 传入 Calculator。Calculator 实现类 MUST NOT 内部发起任何异步 VCM 数据获取。

`CapturePointManager` MUST 直接实现 `IMapMatrixOps`，无需适配器类。

#### Scenario: Calculator 通过 data 和 ops 访问数据与方法
- **WHEN** Calculator 实现类调用 `data.StNewVcm` 或 `ops.GetPointFromVcm(vcm)`
- **THEN** 返回与直接调用原 `CapturePointManager` 对应方法相同的数据

#### Scenario: VCM 数据在进入 Calculator 前已全部就绪
- **WHEN** `GetMapMatrixAsync` 构造 `MapMatrixData` 时
- **THEN** `StNewVcm`、`EdNewVcm`、`StOldVcm`、`EdOldVcm` 四个属性均已完成异步获取并赋值，不存在 null 或未完成的 Task

---

### Requirement: BothVisioned 场景实现
`BothVisionedCalculator` SHALL 在起点和终点 `RegPtType` 均为 `Visioned` 时，分别从起终点新 VCM 提取各自的法向量和点位，构建 `IMapCalculator`。

#### Scenario: 双视觉识别成功
- **WHEN** `stCapturePt.RegType == Visioned` 且 `edCapturePt.RegType == Visioned`
- **THEN** 分别调用 `GetNormalFromVcm(wsg, stNewVcm)` 和 `GetNormalFromVcm(wsg, edNewVcm)` 获取各自法向量，使用 `GetPointFromVcm` 获取各自点位，调用 `CalcCoordinateMatrix(stMn, stSn, stPt, edMn, edSn, edPt)` 返回坐标计算器

---

### Requirement: BothRobotRecord 场景实现
`BothRobotRecordCalculator` SHALL 在起点和终点 `RegPtType` 均为 `RobotRecord` 时，根据哪个点有记录来分别处理。法向量和位置通过记录数据或旧 VCM 获取，使用分离的起终点法向量构建 `IMapCalculator`。

#### Scenario: 起点有记录，终点需推算
- **WHEN** `stCapturePt.RegType == RobotRecord && edCapturePt.RegType == RobotRecord` 且 `IsPtRecorded(stCapturePt) == true`
- **THEN** 从记录获取起点位置及法向量，通过焊缝长度推算终点位置，返回坐标计算器，并调用 `SetRecordPoseNormal` 更新终点法向量

#### Scenario: 终点有记录，起点需推算
- **WHEN** `stCapturePt.RegType == RobotRecord && edCapturePt.RegType == RobotRecord` 且 `IsPtRecorded(edCapturePt) == true`
- **THEN** 从记录获取终点位置及法向量，通过焊缝长度推算起点位置，返回坐标计算器，并调用 `SetRecordPoseNormal` 更新起点法向量

---

### Requirement: StartRobotRecord 场景实现
`StartRobotRecordCalculator` SHALL 在仅起点 `RegPtType` 为 `RobotRecord`、终点为 `Visioned` 时处理。使用分离的起终点法向量构建 `IMapCalculator`。

#### Scenario: 起点有机器人记录
- **WHEN** `stCapturePt.RegType == RobotRecord` 且 `IsPtRecorded(stCapturePt) == true`
- **THEN** 使用记录值作为起点，使用 `edNewVcm` 计算终点与法向量，返回坐标计算器

#### Scenario: 起点无机器人记录，回退使用旧 VCM
- **WHEN** `stCapturePt.RegType == RobotRecord` 且 `IsPtRecorded(stCapturePt) == false`
- **THEN** 使用旧 VCM 推算起点位置，终点使用 `edNewVcm`，返回坐标计算器，并调用 `SetRecordPoseNormal` 更新起点法向量

---

### Requirement: EndRobotRecord 场景实现
`EndRobotRecordCalculator` SHALL 在仅终点 `RegPtType` 为 `RobotRecord`、起点为 `Visioned` 时处理。使用分离的起终点法向量构建 `IMapCalculator`。

#### Scenario: 终点有机器人记录
- **WHEN** `edCapturePt.RegType == RobotRecord` 且 `IsPtRecorded(edCapturePt) == true`
- **THEN** 使用 `stNewVcm` 计算起点，使用记录值作为终点，返回坐标计算器

#### Scenario: 终点无机器人记录，回退使用旧 VCM
- **WHEN** `edCapturePt.RegType == RobotRecord` 且 `IsPtRecorded(edCapturePt) == false`
- **THEN** 起点使用 `stNewVcm`，使用旧 VCM 推算终点位置，返回坐标计算器，并调用 `SetRecordPoseNormal` 更新终点法向量

---

### Requirement: 字典注册选择策略
系统 SHALL 通过 `(RegPtType stType, RegPtType edType)` 元组为键的字典，在 `CapturePointManager` 构造时完成 Calculator 注册，`GetMapMatrixAsync` MUST 通过字典查找而非 switch/if-else 选择实现类。注册条目 MUST 覆盖 `RobotRecordAndVisioned` 和 `RobotRecordAngUnRegnize` 的相关组合。

#### Scenario: 已注册场景的策略选择
- **WHEN** `GetMapMatrixAsync` 以当前起终点的 `RegPtType` 组合查找字典
- **THEN** 返回对应的 `IMapCalculatable` 实例，不抛出异常

#### Scenario: 未注册场景的策略缺失
- **WHEN** `GetMapMatrixAsync` 查找字典但该组合未注册
- **THEN** 抛出 `NotSupportedException` 并携带描述性信息（包含 stType 和 edType 的值）

#### Scenario: RobotRecordAndVisioned 双端场景被正确路由
- **WHEN** `stCapturePt.RegType == RobotRecordAndVisioned` 且 `edCapturePt.RegType == RobotRecordAndVisioned`
- **THEN** 字典返回 `BothRobotRecordVisionedCalculator` 实例

#### Scenario: RobotRecordAngUnRegnize 场景被路由到 RobotRecord 的 Calculator
- **WHEN** `stCapturePt.RegType == RobotRecordAngUnRegnize` 且 `edCapturePt.RegType == RobotRecordAngUnRegnize`
- **THEN** 字典返回 `BothRobotRecordCalculator` 实例（与 `(RobotRecord, RobotRecord)` 键共享同一实例）

---

### Requirement: GetMapMatrixAsync 返回 IMapCalculator
`GetMapMatrixAsync(WeldSeamGroup wsg, CancellationToken token): Task<IMapCalculator>` 的返回类型由 `Matrix4x4` 变更为 `IMapCalculator`。调用方通过 `CalcBy(t)` 获取对应焊接路径位置的变换矩阵。旧坐标矩阵的逆仍通过 `Mul` 左乘到计算器中。

#### Scenario: 调用方根据 t 值获取变换
- **WHEN** 外部代码调用 `GetMapMatrixAsync` 获得 `IMapCalculator` 后
- **THEN** 可通过 `CalcBy(t)` 对焊接路径上的每个点按其在焊缝中的归一化位置获取对应的精定位变换矩阵
