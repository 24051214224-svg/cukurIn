const getActiveAdminIds = async (client) => {
  const result = await client.query(
    `SELECT id
     FROM users
     WHERE role = 'admin' AND is_active = TRUE`
  );
  return result.rows.map((admin) => admin.id);
};

const insertNotifications = async (
  client,
  userIds,
  title,
  message,
  notificationType
) => {
  if (userIds.some((userId) => typeof userId !== "string" || !userId)) {
    throw new Error("Notification recipient is required");
  }

  const recipients = [...new Set(userIds)];
  if (recipients.length === 0) return;

  await client.query(
    `INSERT INTO notifications (user_id, title, message, notification_type)
     SELECT DISTINCT recipients.user_id, $2, $3, $4
     FROM unnest($1::uuid[]) AS recipients(user_id)`,
    [recipients, title, message, notificationType]
  );
};

const assertBookingContext = ({ bookingCode, customerId, barberUserId }) => {
  if (typeof bookingCode !== "string" || !bookingCode) {
    throw new Error("Booking code is required for notification");
  }
  if (customerId !== undefined && (typeof customerId !== "string" || !customerId)) {
    throw new Error("Customer ID is required for notification");
  }
  if (barberUserId !== undefined && (typeof barberUserId !== "string" || !barberUserId)) {
    throw new Error("Barber user ID is required for notification");
  }
};

const notifyBookingCreated = async (client, { barberUserId, bookingCode }) => {
  assertBookingContext({ barberUserId, bookingCode });
  const adminIds = await getActiveAdminIds(client);
  await insertNotifications(
    client,
    [barberUserId, ...adminIds],
    "Booking baru",
    `Booking ${bookingCode} baru masuk.`,
    "booking"
  );
};

const notifyBookingConfirmed = async (
  client,
  { customerId, bookingCode }
) => {
  assertBookingContext({ customerId, bookingCode });
  await insertNotifications(
    client,
    [customerId],
    "Booking dikonfirmasi",
    `Booking ${bookingCode} telah dikonfirmasi.`,
    "booking"
  );
};

const notifyBookingCancelled = async (
  client,
  { customerId, barberUserId, bookingCode }
) => {
  assertBookingContext({ customerId, barberUserId, bookingCode });
  const adminIds = await getActiveAdminIds(client);
  await insertNotifications(
    client,
    [customerId, barberUserId, ...adminIds],
    "Booking dibatalkan",
    `Booking ${bookingCode} dibatalkan.`,
    "booking"
  );
};

const queueNotificationContent = {
  called: {
    title: "Antrean dipanggil",
    message: ({ bookingCode, queueNumber }) =>
      `Antrean nomor ${queueNumber} untuk booking ${bookingCode} dipanggil.`,
  },
  serving: {
    title: "Antrean dimulai",
    message: ({ bookingCode, queueNumber }) =>
      `Antrean nomor ${queueNumber} untuk booking ${bookingCode} mulai dilayani.`,
  },
  completed: {
    title: "Antrean selesai",
    message: ({ bookingCode, queueNumber }) =>
      `Antrean nomor ${queueNumber} untuk booking ${bookingCode} selesai dilayani.`,
  },
};

const notifyQueueStatus = async (
  client,
  { customerId, bookingCode, queueNumber },
  status
) => {
  const content = queueNotificationContent[status];
  if (!content) {
    throw new Error("Unsupported queue notification status");
  }
  assertBookingContext({ customerId, bookingCode });
  if (!Number.isInteger(queueNumber) || queueNumber < 1) {
    throw new Error("Queue number is required for notification");
  }

  await insertNotifications(
    client,
    [customerId],
    content.title,
    content.message({ bookingCode, queueNumber }),
    "queue"
  );
};

module.exports = {
  notifyBookingCreated,
  notifyBookingConfirmed,
  notifyBookingCancelled,
  notifyQueueStatus,
};
