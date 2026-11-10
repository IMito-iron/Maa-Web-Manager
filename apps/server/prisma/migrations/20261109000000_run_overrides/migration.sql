-- WIN-PARITY: "this run only" options of a manual run (JSON keyed by task index). Additive and
-- nullable: older Manager builds ignore the column, so rollback needs no down migration.
ALTER TABLE "Run" ADD COLUMN "overrides" TEXT;
