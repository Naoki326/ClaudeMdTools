## 1. 定义接口与上下文

- [x] 1.1 在 `Scanning/MapMatrix/` 目录下创建 `IMapMatrixCalculator.cs`，定义 `CalcAsync(IMapMatrixComputeContext, CancellationToken): Task<Matrix4x4>` 接口
- [x] 1.2 在 `Scanning/MapMatrix/` 目录下创建 `IMapMatrixComputeContext.cs`，声明数据属性（`Wsg`、`StCapturePt`、`EdCapturePt`、`StNewVcm`、`EdNewVcm`、`StOldVcm`、`EdOldVcm`）及工具方法签名
- [x] 1.3 在 `Scanning/MapMatrix/` 目录下创建 `MapMatrixComputeContext.cs`，实现 `IMapMatrixComputeContext`，将工具方法委托到 `CapturePointManager` 对应的内部方法（通过构造函数注入或 lambda）

## 2. 实现各场景 Calculator

- [x] 2.1 创建 `Scanning/MapMatrix/Calculators/BothVisionedCalculator.cs`：使用 `context.StNewVcm` 和 `context.EdNewVcm` 计算坐标矩阵
- [x] 2.2 创建 `Scanning/MapMatrix/Calculators/BothRobotRecordCalculator.cs`：根据 `IsPtRecorded` 区分起点/终点有记录的两个子分支，各分支通过焊缝长度推算对端点位，并调用 `SetRecordPoseNormal`
- [x] 2.3 创建 `Scanning/MapMatrix/Calculators/StartRobotRecordCalculator.cs`：起点有记录时用记录值，无记录时用旧 VCM 回退并调用 `SetRecordPoseNormal`；终点始终使用 `EdNewVcm`
- [x] 2.4 创建 `Scanning/MapMatrix/Calculators/EndRobotRecordCalculator.cs`：终点有记录时用记录值，无记录时用旧 VCM 回退并调用 `SetRecordPoseNormal`；起点始终使用 `StNewVcm`

## 3. 注册字典与重构 GetMapMatrixAsync

- [x] 3.1 在 `CapturePointManager` 中添加 `_calculators` 字典字段，类型为 `Dictionary<(RegPtType, RegPtType), IMapMatrixCalculator>`
- [x] 3.2 在构造函数中完成四个场景的 Calculator 注册：`(Visioned, Visioned)`、`(RobotRecord, RobotRecord)`、`(RobotRecord, Visioned)`、`(Visioned, RobotRecord)`
- [x] 3.3 重构 `GetMapMatrixAsync`：在方法顶部统一 await 预取全部四份 VCM 数据（`StNewVcm`、`EdNewVcm`、`StOldVcm`、`EdOldVcm`），通过字典查找 Calculator，构造 `MapMatrixComputeContext`，调用 `CalcAsync`，未找到时抛出 `NotSupportedException`
- [x] 3.4 删除 `GetMapMatrixAsync` 中原有的所有 if/else 场景分支代码

## 4. 验证

- [ ] 4.1 对每个 Calculator 类编写单元测试，覆盖 spec 中各 Scenario（使用 mock 的 `IMapMatrixComputeContext`）
- [ ] 4.2 运行现有集成测试，确认 `GetMapMatrixAsync` 对外行为与重构前一致
- [x] 4.3 确认新增场景只需新增 Calculator 类 + 注册一行，无需修改已有 Calculator 代码

## 5. 接口重命名与 t 值姿态变换

- [x] 5.1 重命名策略接口 `IMapMatrixCalculator` → `IMapCalculatable`，更新所有引用
- [x] 5.2 定义 `IMapCalculator` 接口（`CalcBy(double t): Matrix4x4`、`Mul(Matrix4x4 lMat): void`），`CalcAsync` 返回类型由 `Task<Matrix4x4>` 变更为 `Task<IMapCalculator>`
- [x] 5.3 统一类型名拼写：`IMapMatrixOps.CalcCoordinateMatrix` 返回类型及所有 Calculator 实现中的 `IMapCalculator` 应统一为 `IMapCalculator`
- [x] 5.4 实现 `MapCaculator.CalcBy(double t)` 的 t 值插值逻辑（起点 t=0、终点 t=1 之间插值姿态变换矩阵）

## 6. 起终点法向量独立处理

- [x] 6.1 更新 `IMapMatrixOps.GetNormalFromVcm` 签名为单 VCM 版本 `(WeldSeamGroup wsg, VisionCapModel vcm)`
- [x] 6.2 更新 `IMapMatrixOps.CalcCoordinateMatrix` 签名为 6 参数版本 `(stMn, stSn, stPt, edMn, edSn, edPt)` 返回 `IMapCalculator`
- [x] 6.3 更新 `BothVisionedCalculator` 使用分离的 `GetNormalFromVcm` 和 6 参数 `CalcCoordinateMatrix`
- [x] 6.4 更新 `BothRobotRecordVisionedCalculator`、`StartRobotRecordVisionedCalculator`、`EndRobotRecordVisionedCalculator` 使用分离的单 VCM `GetNormalFromVcm` 和 6 参数 `CalcCoordinateMatrix`
- [x] 6.5 更新 `BothRobotRecordCalculator`、`StartRobotRecordCalculator`、`EndRobotRecordCalculator` 使用 6 参数 `CalcCoordinateMatrix`
- [x] 6.6 更新 `CapturePointManager` 中 `GetNormalFromVcm` 和 `CalcCoordinateMatrix` 的显式接口实现，匹配新签名

## 7. 调用链适配

- [x] 7.1 更新 `ApplyPrecisePositioningMatrix` 接受 `IMapCalculator` 替代 `Matrix4x4`，内部按焊接点的 t 值调用 `CalcBy(t)` 应用变换
- [x] 7.2 更新 `IDualPrecisePositionAppService.GetMapMatrixAsync` 和 `DualArmPrecisePositioningAppService` 的返回类型为 `IMapCalculator`
- [x] 7.3 更新 `10.WeldExecute.cs` 中的调用方，传递 `IMapCalculator` 到 `ApplyPrecisePositioningMatrix`
