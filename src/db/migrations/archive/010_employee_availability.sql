-- 010: Employee availability — schedule windows when employees accept jobs
-- Currently no way to know if an employee is available beyond is_active boolean

CREATE TABLE IF NOT EXISTS employee_availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),  -- 0=Sun, 6=Sat
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  CHECK (end_time > start_time),
  UNIQUE(employee_id, day_of_week)  -- one slot per day per employee
);

CREATE INDEX IF NOT EXISTS idx_employee_availability_employee_id ON employee_availability(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_availability_day ON employee_availability(day_of_week);
