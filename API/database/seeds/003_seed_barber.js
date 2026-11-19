const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
});

const bcrypt = require("bcryptjs");
const pool = require("../../src/config/database");
const { createBarberSchema } = require("../../src/validators/barberValidator");

const readSeedData = () => {
  const parsed = createBarberSchema.safeParse({
    full_name: process.env.SEED_BARBER_NAME,
    email: process.env.SEED_BARBER_EMAIL,
    phone_number: process.env.SEED_BARBER_PHONE,
    password: process.env.SEED_BARBER_PASSWORD,
    bio: process.env.SEED_BARBER_BIO || null,
    experience_years: process.env.SEED_BARBER_EXPERIENCE_YEARS
      ? Number(process.env.SEED_BARBER_EXPERIENCE_YEARS)
      : 0,
    is_available: true,
  });

  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => `${issue.path[0]}: ${issue.message}`)
      .join("; ");
    throw new Error(`Seed configuration is invalid (${fields})`);
  }

  return parsed.data;
};

const seedBarber = async (barber) => {
  const passwordHash = await bcrypt.hash(barber.password, 12);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existingUsers = await client.query(
      `SELECT id, role
       FROM users
       WHERE email = $1 OR phone_number = $2
       FOR UPDATE`,
      [barber.email, barber.phone_number]
    );

    if (existingUsers.rows.length > 1) {
      throw new Error("Seed email and phone belong to different accounts");
    }

    let userId;
    if (existingUsers.rows.length === 1) {
      const existingUser = existingUsers.rows[0];
      if (existingUser.role !== "barber") {
        throw new Error("Seed account conflicts with a non-barber account");
      }

      userId = existingUser.id;
      await client.query(
        `UPDATE users
         SET full_name = $1,
             email = $2,
             phone_number = $3,
             password_hash = $4,
             role = 'barber',
             is_active = TRUE,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
        [
          barber.full_name,
          barber.email,
          barber.phone_number,
          passwordHash,
          userId,
        ]
      );
    } else {
      const userResult = await client.query(
        `INSERT INTO users (
           full_name, email, phone_number, password_hash, role
         )
         VALUES ($1, $2, $3, $4, 'barber')
         RETURNING id`,
        [barber.full_name, barber.email, barber.phone_number, passwordHash]
      );
      userId = userResult.rows[0].id;
    }

    const barberResult = await client.query(
      `INSERT INTO barbers (user_id, bio, experience_years, is_available)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (user_id)
       DO UPDATE SET bio = EXCLUDED.bio,
                     experience_years = EXCLUDED.experience_years,
                     is_available = TRUE,
                     updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [userId, barber.bio, barber.experience_years]
    );

    await client.query("COMMIT");
    return barberResult.rows[0].id;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Barber seed rollback error:", rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
};

const main = async () => {
  try {
    const barber = readSeedData();
    const barberId = await seedBarber(barber);
    console.log("Barber seed completed:", barberId);
  } catch (error) {
    console.error("Barber seed failed:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

if (require.main === module) {
  main();
}

module.exports = { readSeedData, seedBarber };
