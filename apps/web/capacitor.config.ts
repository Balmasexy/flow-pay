import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.flowpay.app",
  appName: "FlowPay",
  webDir: "dist",
  server: {
    androidScheme: "https"
  }
};

export default config;
