import { proto } from '../../WAProto/index.js';
import { QueryIds, XWAPaths } from '../Types/index.js';
import { generateProfilePicture } from '../Utils/messages-media.js';
import { getBinaryNodeChild, getBinaryNodeChildren, S_WHATSAPP_NET } from '../WABinary/index.js';
import { makeGroupsSocket } from './groups.js';
import { executeWMexQuery as genericExecuteWMexQuery } from './mex.js';
const parseNewsletterCreateResponse = (response) => {
    const { id, thread_metadata: thread, viewer_metadata: viewer } = response;
    return {
        id: id,
        owner: undefined,
        name: thread.name.text,
        creation_time: parseInt(thread.creation_time, 10),
        description: thread.description.text,
        invite: thread.invite,
        subscribers: parseInt(thread.subscribers_count, 10),
        verification: thread.verification,
        picture: {
            id: thread.picture.id,
            directPath: thread.picture.direct_path
        },
        mute_state: viewer.mute
    };
};
const parseNewsletterMetadata = (result) => {
    if (typeof result !== 'object' || result === null) {
        return null;
    }
    const raw = result;
    const node = (raw.result && typeof raw.result === 'object' ? raw.result : raw);
    if (typeof node.id !== 'string') {
        return null;
    }
    const thread = node.thread_metadata ?? {};
    const viewer = node.viewer_metadata ?? {};
    const pic = thread.picture ?? thread.image ?? thread.preview;
    return {
        id: node.id,
        name: thread.name?.text ?? '',
        description: thread.description?.text,
        invite: thread.invite,
        creation_time: thread.creation_time ? parseInt(thread.creation_time, 10) : undefined,
        subscribers: thread.subscribers_count ? parseInt(thread.subscribers_count, 10) : undefined,
        picture: pic ? { id: pic.id, directPath: pic.direct_path } : undefined,
        verification: thread.verification,
        mute_state: viewer.mute
    };
};
const parseFetchedNewsletterMessage = (node) => {
    const plaintext = getBinaryNodeChild(node, 'plaintext');
    const plaintextContent = plaintext?.content;
    const meta = getBinaryNodeChild(node, 'meta');
    const viewsCount = getBinaryNodeChild(node, 'views_count');
    const forwardsCount = getBinaryNodeChild(node, 'forwards_count');
    const responsesCount = getBinaryNodeChild(node, 'responses_count');
    const rcat = getBinaryNodeChild(node, 'rcat');
    const reactionsNode = getBinaryNodeChild(node, 'reactions');
    const reactions = reactionsNode
        ? getBinaryNodeChildren(reactionsNode, 'reaction').map(r => ({
            code: r.attrs.code,
            count: r.attrs.count ? parseInt(r.attrs.count, 10) : 0
        }))
        : [];
    const votesNode = getBinaryNodeChild(node, 'votes');
    const pollVotes = votesNode
        ? getBinaryNodeChildren(votesNode, 'vote').map(v => ({
            count: v.attrs.count ? parseInt(v.attrs.count, 10) : 0,
            hash: v.content instanceof Uint8Array ? v.content : undefined
        }))
        : [];
    let message;
    if (plaintextContent instanceof Uint8Array) {
        try {
            message = proto.Message.decode(plaintextContent);
        }
        catch {
            message = undefined;
        }
    }
    return {
        id: node.attrs.id,
        serverId: node.attrs.server_id,
        type: node.attrs.type,
        timestamp: node.attrs.t ? parseInt(node.attrs.t, 10) : undefined,
        isSender: node.attrs.is_sender === 'true',
        views: viewsCount?.attrs?.count ? parseInt(viewsCount.attrs.count, 10) : undefined,
        forwards: forwardsCount?.attrs?.count ? parseInt(forwardsCount.attrs.count, 10) : undefined,
        responses: responsesCount?.attrs?.count ? parseInt(responsesCount.attrs.count, 10) : undefined,
        editTimestamp: meta?.attrs?.msg_edit_t ? parseInt(meta.attrs.msg_edit_t, 10) : undefined,
        originalTimestamp: meta?.attrs?.original_msg_t ? parseInt(meta.attrs.original_msg_t, 10) : undefined,
        mediaRcat: rcat?.content instanceof Uint8Array ? rcat.content : undefined,
        reactions,
        pollVotes,
        message
    };
};
export const makeNewsletterSocket = (config) => {
    const sock = makeGroupsSocket(config);
    const { query, generateMessageTag } = sock;
    const executeWMexQuery = (variables, queryId, dataPath) => {
        return genericExecuteWMexQuery(variables, queryId, dataPath, query, generateMessageTag);
    };
    const newsletterUpdate = async (jid, updates) => {
        const variables = {
            newsletter_id: jid,
            updates: {
                ...updates,
                settings: null
            }
        };
        return executeWMexQuery(variables, QueryIds.UPDATE_METADATA, 'xwa2_newsletter_update');
    };
    return {
        ...sock,
        newsletterCreate: async (name, description) => {
            const variables = {
                input: {
                    name,
                    description: description ?? null
                }
            };
            const rawResponse = await executeWMexQuery(variables, QueryIds.CREATE, XWAPaths.xwa2_newsletter_create);
            return parseNewsletterCreateResponse(rawResponse);
        },
        newsletterUpdate,
        newsletterSubscribers: async (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.SUBSCRIBERS, XWAPaths.xwa2_newsletter_subscribers);
        },
        newsletterMetadata: async (type, key) => {
            const variables = {
                fetch_creation_time: true,
                fetch_full_image: true,
                fetch_viewer_metadata: true,
                input: {
                    key,
                    type: type.toUpperCase()
                }
            };
            const result = await executeWMexQuery(variables, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata);
            return parseNewsletterMetadata(result);
        },
        newsletterFollow: (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_join_v2);
        },
        newsletterUnfollow: (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNFOLLOW, XWAPaths.xwa2_newsletter_leave_v2);
        },
        newsletterMute: (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.MUTE, XWAPaths.xwa2_newsletter_mute_v2);
        },
        newsletterUnmute: (jid) => {
            return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNMUTE, XWAPaths.xwa2_newsletter_unmute_v2);
        },
        newsletterUpdateName: async (jid, name) => {
            return await newsletterUpdate(jid, { name });
        },
        newsletterUpdateDescription: async (jid, description) => {
            return await newsletterUpdate(jid, { description });
        },
        newsletterUpdatePicture: async (jid, content) => {
            const { img } = await generateProfilePicture(content);
            return await newsletterUpdate(jid, { picture: img.toString('base64') });
        },
        newsletterRemovePicture: async (jid) => {
            return await newsletterUpdate(jid, { picture: '' });
        },
        newsletterReactMessage: async (jid, serverId, reaction) => {
            await query({
                tag: 'message',
                attrs: {
                    to: jid,
                    ...(reaction ? {} : { edit: '7' }),
                    type: 'reaction',
                    server_id: serverId,
                    id: generateMessageTag()
                },
                content: [
                    {
                        tag: 'reaction',
                        attrs: reaction ? { code: reaction } : {}
                    }
                ]
            });
        },
        newsletterFetchMessages: async (jid, count, since, after) => {
            const messagesAttrs = {
                type: 'jid',
                jid,
                count: count.toString()
            };
            if (typeof since === 'number' && since) {
                messagesAttrs.before = since.toString();
            }
            if (after) {
                messagesAttrs.after = after.toString();
            }
            const result = await query({
                tag: 'iq',
                attrs: {
                    id: generateMessageTag(),
                    type: 'get',
                    to: S_WHATSAPP_NET,
                    xmlns: 'newsletter'
                },
                content: [
                    {
                        tag: 'messages',
                        attrs: messagesAttrs
                    }
                ]
            });
            const messagesNode = getBinaryNodeChild(result, 'messages');
            return getBinaryNodeChildren(messagesNode, 'message').map(parseFetchedNewsletterMessage);
        },
        subscribeNewsletterUpdates: async (jid) => {
            const result = await query({
                tag: 'iq',
                attrs: {
                    id: generateMessageTag(),
                    type: 'set',
                    xmlns: 'newsletter',
                    to: jid
                },
                content: [{ tag: 'live_updates', attrs: {}, content: [] }]
            });
            const liveUpdatesNode = getBinaryNodeChild(result, 'live_updates');
            const duration = liveUpdatesNode?.attrs?.duration;
            return duration ? { duration: duration } : null;
        },
        newsletterAdminCount: async (jid) => {
            const response = await executeWMexQuery({ newsletter_id: jid }, QueryIds.ADMIN_COUNT, XWAPaths.xwa2_newsletter_admin_count);
            return response.admin_count;
        },
        newsletterChangeOwner: async (jid, newOwnerJid) => {
            await executeWMexQuery({ newsletter_id: jid, user_id: newOwnerJid }, QueryIds.CHANGE_OWNER, XWAPaths.xwa2_newsletter_change_owner);
        },
        newsletterDemote: async (jid, userJid) => {
            await executeWMexQuery({ newsletter_id: jid, user_id: userJid }, QueryIds.DEMOTE, XWAPaths.xwa2_newsletter_demote);
        },
        newsletterDelete: async (jid) => {
            await executeWMexQuery({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.xwa2_newsletter_delete_v2);
        }
    };
};
//# sourceMappingURL=newsletter.js.map