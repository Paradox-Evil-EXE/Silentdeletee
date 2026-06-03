import { findByProps, find } from "@vendetta/metro";
import { after } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { logger } from "@vendetta";
import { React } from "@vendetta/metro/common";
import Settings from "./Settings";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function silentDeleteMessage(channelId: string, messageId: string) {
    const RestAPI = findByProps("get", "post", "del", "patch");
    try {
        const replacementText: string = storage.replacementText ?? "** **";
        const deleteDelay: number = storage.deleteDelay ?? 200;
        const suppressNotifications: boolean = storage.suppressNotifications ?? true;

        const response = await RestAPI.post({
            url: `/channels/${channelId}/messages`,
            body: {
                content: replacementText,
                flags: suppressNotifications ? 4096 : 0,
                mobile_network_type: "unknown",
                nonce: messageId,
                tts: false,
            },
        });

        await sleep(deleteDelay);
        await RestAPI.del({ url: `/channels/${channelId}/messages/${response.body.id}` });
        await sleep(100);
        await RestAPI.del({ url: `/channels/${channelId}/messages/${messageId}` });
        logger.log("[SilentDelete] Success!");
        return true;
    } catch (err) {
        logger.log("[SilentDelete] Error: " + String(err));
        return false;
    }
}

let patches: (() => void)[] = [];
let isLoaded = false;

export default {
    onLoad() {
        if (isLoaded) return;
        isLoaded = true;

        storage.replacementText ??= "** **";
        storage.deleteDelay ??= 200;
        storage.suppressNotifications ??= true;

        // Find the actual context menu UI component — must have a `default` that is
        // a React function/component, and the module key must suggest it's an action sheet
        const menuModule = find((m: any) => {
            try {
                if (
                    m &&
                    typeof m.default === "function" &&
                    m.default.name &&
                    (
                        m.default.name.toLowerCase().includes("longpress") ||
                        m.default.name.toLowerCase().includes("actionsheet") ||
                        m.default.name.toLowerCase().includes("contextmenu") ||
                        m.default.name.toLowerCase().includes("messagemenu") ||
                        m.default.name.toLowerCase().includes("messageaction")
                    )
                ) {
                    logger.log("[SilentDelete] Candidate: " + m.default.name);
                    return true;
                }
            } catch {}
            return false;
        });

        if (!menuModule) {
            logger.warn("[SilentDelete] No menu module found. Dumping all default-exported React components with 'message' in name:");
            find((m: any) => {
                try {
                    if (m && typeof m.default === "function" && m.default.name?.toLowerCase().includes("message")) {
                        logger.log("[SilentDelete] >> " + m.default.name);
                    }
                } catch {}
                return false;
            });
            return;
        }

        logger.log("[SilentDelete] Using: " + menuModule.default.name);

        const { ModalActionButton } = findByProps("ModalActionButton");

        const unpatch = after("default", menuModule, (args: any[], res: any) => {
            const props = args[0];
            const message = props?.message ?? props?.targetMessage;
            if (!message) return res;

            const UserStore = findByProps("getCurrentUser");
            const currentUser = UserStore?.getCurrentUser();
            if (!currentUser || message.author?.id !== currentUser.id) return res;

            const channelId: string = message.channel_id;
            const messageId: string = message.id;

            const btn = React.createElement(ModalActionButton, {
                text: "Silent Delete",
                destructive: true,
                onPress: () => silentDeleteMessage(channelId, messageId),
            });

            try {
                if (Array.isArray(res?.props?.children)) {
                    res.props.children.push(btn);
                } else if (res?.props?.children) {
                    res.props.children = [res.props.children, btn];
                }
            } catch (e) {
                logger.log("[SilentDelete] Failed to inject button: " + String(e));
            }

            return res;
        });

        patches.push(unpatch);
        logger.log("[SilentDelete] Loaded successfully.");
    },

    onUnload() {
        for (const unpatch of patches) unpatch();
        patches = [];
        isLoaded = false;
        logger.log("[SilentDelete] Unloaded.");
    },

    settings: Settings,
};
