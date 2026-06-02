import { findByProps } from "@vendetta/metro";
import { after } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";
import { logger } from "@vendetta";
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

function isOwnMessage(message: any): boolean {
    try {
        const UserStore = findByProps("getCurrentUser");
        const currentUser = UserStore?.getCurrentUser?.();
        return !!currentUser && message?.author?.id === currentUser.id;
    } catch {
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

        // Discord mobile builds the message long-press sheet via useMessageMenu.
        // Patching it with `after` lets us append our button to the returned
        // items array — only for our own messages.
        const MessageMenu = findByProps("useMessageMenu");

        if (!MessageMenu) {
            logger.warn("[SilentDelete] useMessageMenu module not found");
            return;
        }

        const unpatch = after("useMessageMenu", MessageMenu, (args: any[], returnValue: any) => {
            // args[0] is the options object: { message, channel, ... }
            const message = args[0]?.message;
            const channel = args[0]?.channel;

            // Only inject for your own messages
            if (!message || !channel || !isOwnMessage(message)) return;

            // returnValue is an array of menu item groups (arrays of items)
            // Find the group containing the delete action so we can place
            // Silent Delete right below it
            if (!Array.isArray(returnValue)) return;

            const silentDeleteItem = {
                key: "silent-delete",
                label: "Silent Delete",
                // Use the same destructive red styling as the real Delete button
                variant: "destructive",
                icon: "TrashIcon",
                action() {
                    silentDeleteMessage(channel.id, message.id);
                },
            };

            // returnValue is a flat array of items, or an array of groups.
            // Handle both shapes:
            if (Array.isArray(returnValue[0])) {
                // Grouped shape: [[item, item], [item], ...]
                for (let g = 0; g < returnValue.length; g++) {
                    const group = returnValue[g];
                    const deleteIdx = group.findIndex(
                        (item: any) =>
                            item?.key === "delete" ||
                            item?.label?.toLowerCase?.().includes("delete")
                    );
                    if (deleteIdx !== -1) {
                        group.splice(deleteIdx + 1, 0, silentDeleteItem);
                        return;
                    }
                }
                // Delete item not found — append to last group
                returnValue[returnValue.length - 1]?.push(silentDeleteItem);
            } else {
                // Flat shape: [item, item, ...]
                const deleteIdx = returnValue.findIndex(
                    (item: any) =>
                        item?.key === "delete" ||
                        item?.label?.toLowerCase?.().includes("delete")
                );
                if (deleteIdx !== -1) {
                    returnValue.splice(deleteIdx + 1, 0, silentDeleteItem);
                } else {
                    returnValue.push(silentDeleteItem);
                }
            }
        });

        patches.push(unpatch);
        logger.log("[SilentDelete] Loaded — useMessageMenu patched.");
    },

    onUnload() {
        for (const unpatch of patches) unpatch();
        patches = [];
        isLoaded = false;
        logger.log("[SilentDelete] Unloaded.");
    },

    settings: Settings,
};
