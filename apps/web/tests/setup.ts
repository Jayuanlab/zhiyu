import { beforeEach, vi } from "vitest";
import { installUnitIsolation } from "./isolation";

// No dotenv loading: unit tests must not inherit local external adapters.
installUnitIsolation();
beforeEach(installUnitIsolation);

// Mock server-only globally to prevent "Client Component" errors in tests
vi.mock("server-only", () => ({}));
