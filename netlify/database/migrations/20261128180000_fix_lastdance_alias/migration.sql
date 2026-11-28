-- 修正错误认领映射：Lastdance轩少 是轩少本人的游戏ID（2026-11-27 数据核对时用户确认），
-- 原映射「Lastdance轩少→白云」系误挂，曾导致 11-27 第 1、5 场轩少记录被记到白云名下。
-- 本次仅改映射；历史 games/tournaments 数据已在 11-28 通过逐条 PUT 修复完毕，无需再动。
UPDATE "nick_aliases" SET "nickname" = '轩少' WHERE "alias" = 'Lastdance轩少' AND "nickname" = '白云';
