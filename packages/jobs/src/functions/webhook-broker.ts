import { inngest } from '../client.js';
import { db, webhookSubscriptions, webhookDeliveries } from '@synap/database';
import { eq, and } from '@synap/database';
import { createHmac } from 'crypto';

/**
 * Webhook Broker
 * 
 * Listens to all events and delivers them to registered webhooks.
 * Handles filtering, HMAC signing, and delivery logging.
 */
export const handleWebhookDelivery = inngest.createFunction(
  { id: 'webhook-broker', name: 'Webhook Broker' },
  { event: 'api/event.logged' },
  async ({ event, step }) => {
    const { type, userId } = event.data;
    const eventId = event.data.id;

    // Step 1: Find matching subscriptions
    const subscriptions = await step.run('find-subscriptions', async () => {
      // Find active subscriptions for this user
      const allSubs = await db.select().from(webhookSubscriptions).where(
        and(
          eq(webhookSubscriptions.userId, userId),
          eq(webhookSubscriptions.active, true)
        )
      ).execute();
      
      // Filter in memory for subscriptions that include this event type
      return allSubs.filter(sub => sub.eventTypes.includes(type));
    });

    if (subscriptions.length === 0) {
      return { status: 'no-subscriptions' };
    }

    // Step 2: Deliver to each subscription
    const results = await Promise.all(subscriptions.map(async (sub) => {
      return step.run(`deliver-${sub.id}`, async () => {
        const payload = JSON.stringify(event.data);
        
        // Create HMAC signature
        const signature = createHmac('sha256', sub.secret)
          .update(payload)
          .digest('hex');

        let status = 'pending';
        let responseStatus = 0;
        let errorMsg = '';

        try {
          const response = await fetch(sub.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Synap-Signature': signature,
              'X-Synap-Event-Type': type,
              'X-Synap-Event-Id': eventId,
              'User-Agent': 'Synap-Webhook/1.0',
            },
            body: payload,
          });

          responseStatus = response.status;
          status = response.ok ? 'success' : 'failed';
          
          if (!response.ok) {
            errorMsg = `HTTP ${response.status}: ${response.statusText}`;
          }
        } catch (error) {
          status = 'failed';
          errorMsg = error instanceof Error ? error.message : 'Unknown error';
        }

        // Log delivery attempt
        await db.insert(webhookDeliveries).values({
          subscriptionId: sub.id,
          eventId: eventId,
          status,
          responseStatus: responseStatus || null,
          attempt: 1,
          deliveredAt: status === 'success' ? new Date() : null,
        });

        // Update last triggered time
        if (status === 'success') {
          await db.update(webhookSubscriptions)
            .set({ lastTriggeredAt: new Date() })
            .where(eq(webhookSubscriptions.id, sub.id));
        }

        return { 
          subscriptionId: sub.id, 
          status, 
          responseStatus,
          error: errorMsg || undefined 
        };
      });
    }));

    return { 
      status: 'delivered', 
      count: results.length,
      results 
    };
  }
);
