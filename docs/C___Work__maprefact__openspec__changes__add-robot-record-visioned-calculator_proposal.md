## Why

打断点场景（`RobotRecord`）目前只使用机器人记录的位置，法向量通过旧 VCM 或焊缝长度推算，精度受限。新增 `RobotRecordAndVisioned` 场景，在使用机器人记录位置的同时额外拍照识别方向，以获得更准确的法向量。`RegPtType` 枚举已扩展此类型，框架支持扩展，现在需要对应的 Calculator 实现。

## What Changes

- 新增 `RobotRecordAndVisioned` 场景的 Calculator 实现类（起终点均可为该类型）：
  - `BothRobotRecordVisionedCalculator`：双端均为机器人记录位置+视觉方向
  - `StartRobotRecordVisionedCalculator`：起点为机器人记录+视觉方向，终点为纯 Visioned
  - `EndRobotRecordVisionedCalculator`：终点为机器人记录+视觉方向，起点为纯 Visioned
- 法向量从各端点的新 VCM 独立提取（`GetNormalFromVcm(wsg, vcm)` 单 VCM 调用），不再合并平均
- 当视觉识别方向失败（`RobotRecordAngUnRegnize`）时，回退到旧 VCM 法向量（原 `RobotRecord` 策略）
- 在 `CapturePointManager` 构造函数中注册上述新组合的字典映射

## Capabilities

### New Capabilities

- `robot-record-visioned-calculator`：`RobotRecordAndVisioned` 场景的 Calculator 集合——使用机器人记录位置与视觉识别法向量（独立提取）计算坐标计算器

### Modified Capabilities

- `map-matrix-calculator`：字典映射新增 `RobotRecordAndVisioned` 相关组合的注册条目，以及 `RobotRecordAngUnRegnize` 失败回退场景的处理规则

## Impact

- `src/Weldone.Application/Scanning/MapMatrix/Calculators/`：新增 3 个 Calculator 类
- `src/Weldone.Application/Scanning/CapturePointManager.cs`：构造函数中追加新组合注册（不修改已有逻辑）
- `src/Weldone.Application.Contracts/Scanning/CurrentWsgScanSuggestion.cs`：`RegPtType` 枚举已扩展（已完成，无需再改）
