import { findByProps } from "@vendetta/metro";
import { storage } from "@vendetta/plugin";
import { logger } from "@vendetta";
import { before } from "@vendetta/patcher";
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
        console.error("[SilentDelete] Error:", err);
        return false;
    }
}

let patches: (() => void)[] = [];
let isLoaded = false;

export default {
    onLoad() {
        if (isLoaded) {
            logger.warn("[SilentDelete] Already loaded, skipping.");
            return;
        }
        isLoaded = true;

        storage.replacementText ??= "** **";
        storage.deleteDelay ??= 200;
        storage.suppressNotifications ??= true;

        // Patch the message context menu to add a "Silent Delete" button
        // only for your own messages (canDelete === true).
        const MessageContextMenu = findByProps("MessageContextMenu") ?? findByProps("useMessageMenu");

        // Vendetta exposes context menu items via the message long-press action sheet.
        // We patch the function that builds the action sheet items array.
        const ActionSheetUtils = findByProps("openLazy", "hideActionSheet");
        const MessageActions = findByProps("deleteMessage", "sendMessage");

        if (!ActionSheetUtils || !MessageActions) {
            logger.warn("[SilentDelete] Required modules not found");
            return;
        }

        // Hook into the message context menu builder
        const ContextMenuModule = findByProps("MessageContextMenu", "useMessageMenu")
            ?? findByProps("buildMessageContextMenuData");

        if (!ContextMenuModule) {
            logger.warn("[SilentDelete] ContextMenuModule not found");
            return;
        }

        // The key function name may vary — try both common names
        const menuFnKey = Object.keys(ContextMenuModule).find(
            (k) => typeof ContextMenuModule[k] === "function" &&
                   (k.includes("MessageContextMenu") || k.includes("useMessageMenu") || k.includes("buildMessage"))
        );

        if (!menuFnKey) {
            logger.warn("[SilentDelete] Could not find context menu function key");
            return;
        }

        const unpatch = before(menuFnKey, ContextMenuModule, (args: any[]) => {
            // args[0] is typically the props/config object for the menu
            const menuProps = args[0];
            if (!menuProps) return;

            const { message, channel } = menuProps;
            if (!message || !channel) return;

            // Only add the button if this is your own message
            // (canDelete or author.id === currentUser.id)
            const UserStore = findByProps("getCurrentUser");
            const currentUser = UserStore?.getCurrentUser?.();
            if (!currentUser || message.author?.id !== currentUser.id) return;

            // Inject our silent delete into the existing items array if present
            const originalItems = menuProps.items ?? menuProps.menuItems;
            if (!Array.isArray(originalItems)) return;

            // Find the normal "Delete Message" item so we can place ours right below it
            const deleteIndex = originalItems.findIndex(
                (item: any) => item?.key === "delete" || item?.label?.toLowerCase?.().includes("delete")
            );

            const silentDeleteItem = {
                key: "silent-delete",
                label: "Silent Delete",
                icon: "ic_trash", // same trash icon as normal delete
                variant: "destructive",
                action: () => {
                    silentDeleteMessage(channel.id, message.id);
                },
            };

            if (deleteIndex !== -1) {
                // Insert immediately after the normal Delete button
                originalItems.splice(deleteIndex + 1, 0, silentDeleteItem);
            } else {
                originalItems.push(silentDeleteItem);
            }
        });

        patches.push(unpatch);
        logger.log("[SilentDelete] Loaded — context menu button injected.");
    },

    onUnload() {
        for (const unpatch of patches) unpatch();
        patches = [];
        isLoaded = false;
        logger.log("[SilentDelete] Unloaded.");
    },

    settings: Settings,
};
