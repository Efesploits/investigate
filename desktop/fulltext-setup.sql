-- STEP 1: run this first. It reads only the SCHEMA (column names/types),
-- never the actual row data, and prints the exact ALTER TABLE statement to run.
SELECT CONCAT(
  'ALTER TABLE `101m` ADD FULLTEXT INDEX ft_search (',
  GROUP_CONCAT('`', COLUMN_NAME, '`' SEPARATOR ', '),
  ');'
) AS run_this_next
FROM information_schema.columns
WHERE TABLE_SCHEMA = '101m'
  AND TABLE_NAME = '101m'
  AND DATA_TYPE IN ('char','varchar','tinytext','text','mediumtext','longtext');

-- STEP 2: copy the single string phpMyAdmin prints above (the run_this_next
-- column value) into a new SQL tab and execute it. On a 10GB / ~100M row
-- MyISAM table this can take a while (potentially 30+ minutes) — let it finish,
-- don't restart MySQL mid-build.
