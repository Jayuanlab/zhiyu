import {
  getWechatDesktopHealth,
  getWechatDesktopServiceConfig,
  previewWechatDesktopMessage,
} from "@/lib/wechat-desktop/client";

type WechatDesktopReadResult = {
  ok: boolean;
  text: string;
  data?: Record<string, unknown>;
  isError?: boolean;
};

function jsonResult(value: Record<string, unknown>, isError = false) {
  return {
    ok: !isError,
    text: JSON.stringify(value, null, 2),
    data: value,
    isError,
  } satisfies WechatDesktopReadResult;
}

export async function checkWechatDesktopHealth(input: {
  getHealth?: typeof getWechatDesktopHealth;
  getConfig?: typeof getWechatDesktopServiceConfig;
} = {}): Promise<WechatDesktopReadResult> {
  const getHealth = input.getHealth ?? getWechatDesktopHealth;
  const getConfig = input.getConfig ?? getWechatDesktopServiceConfig;
  try {
    const health = await getHealth();
    return jsonResult({
      success: true,
      config: getConfig(),
      health,
    });
  } catch (error) {
    return jsonResult(
      {
        success: false,
        config: getConfig(),
        message: error instanceof Error ? error.message : String(error),
      },
      true,
    );
  }
}

export async function previewWechatDesktopMessageForReview(input: {
  recipientName: string;
  message: string;
  previewMessage?: typeof previewWechatDesktopMessage;
}): Promise<WechatDesktopReadResult> {
  const previewMessage =
    input.previewMessage ?? previewWechatDesktopMessage;
  try {
    const preview = await previewMessage({
      recipientName: input.recipientName,
      message: input.message,
    });
    return jsonResult({
      success: true,
      preview,
      nextStep:
        "Ask the user to click the UI confirmation button. Do not call any send tool.",
    });
  } catch (error) {
    return jsonResult(
      {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      },
      true,
    );
  }
}
