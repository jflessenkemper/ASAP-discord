import 'dotenv/config';
import bcrypt from 'bcrypt';
import pool from './pool';

async function seed() {
  // Seed test employee
  const empExists = await pool.query('SELECT id FROM employees WHERE username = $1', ['jflessenkemper']);
  if (empExists.rows.length === 0) {
    const hash = await bcrypt.hash('!Flessenkemper18', 12);
    await pool.query(
      `INSERT INTO employees (username, email, password_hash, rate_per_minute)
       VALUES ($1, $2, $3, $4)`,
      ['jflessenkemper', 'jordan.flessenkemper@gmail.com', hash, 5.00]
    );
    console.log('✓ Seeded test employee: jflessenkemper');
  } else {
    console.log('Test employee already exists, skipping.');
  }

  console.log('Seed complete.');
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
