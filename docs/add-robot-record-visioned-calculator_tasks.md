## 1. 新增 Calculator 类

- [x] 1.1 创建 `Scanning/MapMatrix/Calculators/BothRobotRecordVisionedCalculator.cs`：双端均为 `RobotRecordAndVisioned`，位置取自 `FromRecord2Vec`，法向量分别通过 `GetNormalFromVcm(wsg, StNewVcm)` 和 `GetNormalFromVcm(wsg, EdNewVcm)` 独立获取，调用 6 参数 `CalcCoordinateMatrix` 返回 `IMapCalculator`
- [x] 1.2 创建 `Scanning/MapMatrix/Calculators/StartRobotRecordVisionedCalculator.cs`：起点为 `RobotRecordAndVisioned`（位置来自记录），终点为纯 `Visioned`（`GetPointFromVcm(EdNewVcm)`），法向量分别从各自新 VCM 独立提取
- [x] 1.3 创建 `Scanning/MapMatrix/Calculators/EndRobotRecordVisionedCalculator.cs`：终点为 `RobotRecordAndVisioned`（位置来自记录），起点为纯 `Visioned`（`GetPointFromVcm(StNewVcm)`），法向量分别从各自新 VCM 独立提取

## 2. 注册新组合到字典

- [x] 2.1 在 `CapturePointManager` 构造函数中注册 `RobotRecordAndVisioned` 三个组合：`(RobotRecordAndVisioned, RobotRecordAndVisioned)` → `BothRobotRecordVisionedCalculator`；`(RobotRecordAndVisioned, Visioned)` → `StartRobotRecordVisionedCalculator`；`(Visioned, RobotRecordAndVisioned)` → `EndRobotRecordVisionedCalculator`
- [x] 2.2 在 `CapturePointManager` 构造函数中注册 `RobotRecordAngUnRegnize` 三个回退组合，复用已有实例：`(RobotRecordAngUnRegnize, RobotRecordAngUnRegnize)` → `BothRobotRecordCalculator`；`(RobotRecordAngUnRegnize, Visioned)` → `StartRobotRecordCalculator`；`(Visioned, RobotRecordAngUnRegnize)` → `EndRobotRecordCalculator`

## 3. 验证

- [ ] 3.1 对三个新 Calculator 类编写单元测试，覆盖 spec 中的 Scenario
- [x] 3.2 确认 `RobotRecordAngUnRegnize` 组合通过字典正确路由到已有 Calculator（不抛出 `NotSupportedException`）
