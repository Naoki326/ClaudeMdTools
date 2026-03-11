## Why

`GetMapMatrixAsync` 内部通过大量 if/else 分支，针对起点与终点的 `RegPtType` 组合（Visioned、RobotRecord 已记录、RobotRecord 未记录等）分别计算坐标矩阵。随着识别场景的增加，每新增一种场景就需要向该方法追加分支，导致方法体持续膨胀、难以维护与测试。同时，旧方案对起终点使用相同的平均法向量，无法表达焊缝两端法向量差异，精度受限。

## What Changes

- 引入 `IMapCalculatable` 接口（原 `IMapMatrixCalculator`），将"根据 RegType 组合计算坐标矩阵"的职责提取为独立策略类
- 引入 `IMapCalculator` 接口，支持基于 t 值（t∈[0,1]）的姿态变换插值：`CalcBy(t)` 返回对应位置的变换矩阵，`Mul(lMat)` 支持左乘叠加
- 起终点法向量独立处理：`GetNormalFromVcm` 改为单 VCM 版本，`CalcCoordinateMatrix` 改为 6 参数版本，分别接收起终点的法向量
- 为当前已有的四类场景各实现一个 Calculator 类：
  - `BothVisionedCalculator`：起点和终点均为 Visioned
  - `BothRobotRecordCalculator`：起点和终点均为 RobotRecord（内含已记录/未记录的子逻辑）
  - `StartRobotRecordCalculator`：仅起点为 RobotRecord，终点为 Visioned
  - `EndRobotRecordCalculator`：仅终点为 RobotRecord，起点为 Visioned
- 在 `CapturePointManager` 中根据 `RegPtType` 组合选择对应的 Calculator 实例
- `GetMapMatrixAsync` 精简为：验证 → 选择策略 → 调用策略 → 左乘旧矩阵逆 → 返回结果
- `ApplyPrecisePositioningMatrix` 改为接受 `IMapCalculator`，按焊接路径点的 t 值逐点应用不同的校正矩阵

## Capabilities

### New Capabilities

- `map-matrix-calculator`: `IMapCalculatable` 接口及其各场景实现类，封装根据捕获点识别类型组合计算坐标校准矩阵的逻辑。包含 `IMapCalculator` 的 t 值姿态变换插值能力和起终点法向量独立处理。

### Modified Capabilities

（无需求级别变更，仅为内部实现重构）

## Impact

- `src/Weldone.Application/Scanning/CapturePointManager.cs`：`GetMapMatrixAsync` 方法大幅精简，返回类型变更为 `IMapCalculator`
- 新增文件：`src/Weldone.Application/Scanning/MapMatrix/` 目录下的接口与策略类，包含 `MapCaculator.cs` 实现类
- `GetMapMatrixAsync` 签名变更为 `Task<IMapCalculator>`，调用方需通过 `CalcBy(t)` 获取变换矩阵
- `ApplyPrecisePositioningMatrix` 参数变更为 `IMapCalculator`，内部按 t 值逐点应用校正
