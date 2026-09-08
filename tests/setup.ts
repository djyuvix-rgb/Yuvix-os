import "../src/server/load-env";

// Tests run against a throwaway database so a test run can never touch the
// operator's real records.
process.env.DATABASE_URL = "file:./test.db";
process.env.YUVIX_WORKSPACE_DIR = "./.test-workspace";
process.env.YUVIX_LOG_LEVEL = "error";
