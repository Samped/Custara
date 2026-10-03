declare module "@circle-fin/w3s-pw-web-sdk" {
  export class W3SSdk {
    constructor(
      config?: {
        appSettings?: { appId?: string };
        loginConfigs?: Record<string, unknown>;
      },
      onLoginComplete?: (
        error: unknown,
        result: { userToken?: string; encryptionKey?: string } | null,
      ) => void,
    );
    getDeviceId(): Promise<string> | string;
    updateConfigs(
      config: unknown,
      onLoginComplete?: (
        error: unknown,
        result: { userToken?: string; encryptionKey?: string } | null,
      ) => void,
    ): void;
    verifyOtp(): void;
    setAuthentication(auth: { userToken: string; encryptionKey: string }): void;
    setOnResendOtpEmail(cb: () => void): void;
    setLocalizations(loc: unknown): void;
    setThemeColor(theme: unknown): void;
    execute(
      challengeId: string,
      callback?: (error: unknown, result: unknown) => void,
    ): void;
  }
}
