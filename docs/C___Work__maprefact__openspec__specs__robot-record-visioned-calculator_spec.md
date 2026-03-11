## Purpose

机器人记录位置 + 视觉识别方向（`RobotRecordAndVisioned`）场景的 Calculator 实现集合。在使用机器人记录的位置的同时，通过拍照识别获取更准确的法向量。起终点法向量独立处理，分别从各自的 VCM 提取后传入 `CalcCoordinateMatrix` 构建 `IMapCalculator`。包含视觉方向识别失败（`RobotRecordAngUnRegnize`）时的回退策略。

## Requirements

### Requirement: BothRobotRecordVisioned 场景实现
`BothRobotRecordVisionedCalculator` SHALL 在起点和终点 `RegPtType` 均为 `RobotRecordAndVisioned` 时，使用机器人记录的位置与视觉识别的法向量计算坐标计算器。起终点法向量分别从各自的新 VCM 独立提取。

#### Scenario: 双端均为机器人记录+视觉方向
- **WHEN** `stCapturePt.RegType == RobotRecordAndVisioned` 且 `edCapturePt.RegType == RobotRecordAndVisioned`
- **THEN** 起点和终点位置均来自 `FromRecord2Vec`，法向量分别通过 `GetNormalFromVcm(wsg, StNewVcm)` 和 `GetNormalFromVcm(wsg, EdNewVcm)` 独立获取，调用 `CalcCoordinateMatrix(stMn, stSn, stPt, edMn, edSn, edPt)` 返回坐标计算器

---

### Requirement: StartRobotRecordVisioned 场景实现
`StartRobotRecordVisionedCalculator` SHALL 在起点为 `RobotRecordAndVisioned`、终点为 `Visioned` 时，起点用机器人记录位置与视觉法向量，终点用完整视觉数据。起终点法向量独立处理。

#### Scenario: 起点为机器人记录+视觉方向，终点为纯视觉
- **WHEN** `stCapturePt.RegType == RobotRecordAndVisioned` 且 `edCapturePt.RegType == Visioned`
- **THEN** 起点位置来自 `FromRecord2Vec(StCapturePt)`，起点法向量通过 `GetNormalFromVcm(wsg, StNewVcm)` 获取，终点位置来自 `GetPointFromVcm(EdNewVcm)`，终点法向量通过 `GetNormalFromVcm(wsg, EdNewVcm)` 获取，返回坐标计算器

---

### Requirement: EndRobotRecordVisioned 场景实现
`EndRobotRecordVisionedCalculator` SHALL 在起点为 `Visioned`、终点为 `RobotRecordAndVisioned` 时，终点用机器人记录位置与视觉法向量，起点用完整视觉数据。起终点法向量独立处理。

#### Scenario: 终点为机器人记录+视觉方向，起点为纯视觉
- **WHEN** `stCapturePt.RegType == Visioned` 且 `edCapturePt.RegType == RobotRecordAndVisioned`
- **THEN** 终点位置来自 `FromRecord2Vec(EdCapturePt)`，终点法向量通过 `GetNormalFromVcm(wsg, EdNewVcm)` 获取，起点位置来自 `GetPointFromVcm(StNewVcm)`，起点法向量通过 `GetNormalFromVcm(wsg, StNewVcm)` 获取，返回坐标计算器

---

### Requirement: RobotRecordAngUnRegnize 回退到 RobotRecord 策略
当任一端点的 `RegPtType` 为 `RobotRecordAngUnRegnize`（视觉方向识别失败）时，系统 SHALL 使用与对应 `RobotRecord` 组合相同的 Calculator 实例进行处理，不新增类。

#### Scenario: 双端识别失败，回退到 BothRobotRecord
- **WHEN** `stCapturePt.RegType == RobotRecordAngUnRegnize` 且 `edCapturePt.RegType == RobotRecordAngUnRegnize`
- **THEN** 使用 `BothRobotRecordCalculator` 处理，行为与 `(RobotRecord, RobotRecord)` 相同

#### Scenario: 起点识别失败，回退到 StartRobotRecord
- **WHEN** `stCapturePt.RegType == RobotRecordAngUnRegnize` 且 `edCapturePt.RegType == Visioned`
- **THEN** 使用 `StartRobotRecordCalculator` 处理，行为与 `(RobotRecord, Visioned)` 相同

#### Scenario: 终点识别失败，回退到 EndRobotRecord
- **WHEN** `stCapturePt.RegType == Visioned` 且 `edCapturePt.RegType == RobotRecordAngUnRegnize`
- **THEN** 使用 `EndRobotRecordCalculator` 处理，行为与 `(Visioned, RobotRecord)` 相同
