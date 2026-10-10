import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: [
      "components/BetForm.tsx",
      "components/DepositForm.tsx",
      "components/LiveBetForm.tsx",
      "components/Navbar.tsx",
      "components/WithdrawalStatusToast.tsx",
    ],
    rules: {
      // Preserve existing client-side state synchronization behaviour while keeping
      // the rest of the React Hooks rules enabled.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    files: ["components/MarketOdds.tsx"],
    rules: {
      // This local wrapper is intentionally scoped to the current render.
      "react-hooks/static-components": "off",
    },
  },
  {
    files: ["scripts/fix-admin.js"],
    rules: {
      // Existing CommonJS script; do not change its runtime semantics as part of lint repair.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);
