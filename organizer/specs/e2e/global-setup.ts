import { prepareTestDatabase } from "../../scripts/test-prepare";

async function globalSetup() {
  if (process.env.SKIP_TEST_PREPARE === "1") {
    return;
  }

  prepareTestDatabase();
}

export default globalSetup;
