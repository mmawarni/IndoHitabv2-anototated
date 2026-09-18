CREATE TYPE public.app_role AS ENUM ('admin', 'validator', 'anotator');

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'aktif',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  UNIQUE (user_id, role)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role
  )
$$;

CREATE POLICY "profiles_select_authenticated" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "profiles_update_self" ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE POLICY "profiles_admin_all" ON public.profiles FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "user_roles_select_authenticated" ON public.user_roles FOR SELECT TO authenticated USING (true);
CREATE POLICY "user_roles_admin_all" ON public.user_roles FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TABLE public.tqa_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  title_en text NOT NULL,
  title_id text,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tqa_tables TO authenticated;
GRANT ALL ON public.tqa_tables TO service_role;
ALTER TABLE public.tqa_tables ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tqa_tables_select_authenticated" ON public.tqa_tables FOR SELECT TO authenticated USING (true);
CREATE POLICY "tqa_tables_update_workers" ON public.tqa_tables FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "tqa_tables_admin_write" ON public.tqa_tables FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TABLE public.table_cells (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.tqa_tables(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'header',
  position integer NOT NULL DEFAULT 0,
  source_text text NOT NULL,
  target_text text,
  status text NOT NULL DEFAULT 'draft',
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.table_cells TO authenticated;
GRANT ALL ON public.table_cells TO service_role;
ALTER TABLE public.table_cells ENABLE ROW LEVEL SECURITY;
CREATE POLICY "table_cells_select_authenticated" ON public.table_cells FOR SELECT TO authenticated USING (true);
CREATE POLICY "table_cells_update_workers" ON public.table_cells FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "table_cells_admin_write" ON public.table_cells FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TABLE public.qa_pairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.tqa_tables(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  question_en text NOT NULL,
  answer_en text NOT NULL,
  question_id text,
  answer_id text,
  status text NOT NULL DEFAULT 'draft',
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.qa_pairs TO authenticated;
GRANT ALL ON public.qa_pairs TO service_role;
ALTER TABLE public.qa_pairs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "qa_pairs_select_authenticated" ON public.qa_pairs FOR SELECT TO authenticated USING (true);
CREATE POLICY "qa_pairs_update_workers" ON public.qa_pairs FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "qa_pairs_admin_write" ON public.qa_pairs FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', ''), COALESCE(NEW.email, ''))
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'anotator')
  ON CONFLICT (user_id, role) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

INSERT INTO public.tqa_tables (id, code, title_en, title_id) VALUES
  ('11111111-1111-4111-8111-111111111111', 'HITAB-0007', 'Population density of Southeast Asian countries, 2020', 'Kepadatan penduduk negara Asia Tenggara, 2020'),
  ('22222222-2222-4222-8222-222222222222', 'HITAB-0012', 'Monthly revenue by region and product line', NULL),
  ('33333333-3333-4333-8333-333333333333', 'HITAB-0021', 'Educational attainment by age group', NULL);

INSERT INTO public.table_cells (table_id, kind, position, source_text, target_text, status) VALUES
  ('11111111-1111-4111-8111-111111111111', 'header', 0, 'Country Code', 'Kode Negara', 'selesai'),
  ('11111111-1111-4111-8111-111111111111', 'header', 1, 'Population Density', 'Kepadatan Penduduk', 'selesai'),
  ('11111111-1111-4111-8111-111111111111', 'column', 2, 'GDP per Capita', 'PDB per Kapita', 'selesai'),
  ('11111111-1111-4111-8111-111111111111', 'column', 3, 'Urban Population (%)', NULL, 'draft'),
  ('22222222-2222-4222-8222-222222222222', 'header', 0, 'Total Revenue by Region', NULL, 'draft'),
  ('22222222-2222-4222-8222-222222222222', 'header', 1, 'Quarterly Growth Rate (%)', NULL, 'draft'),
  ('22222222-2222-4222-8222-222222222222', 'column', 2, 'Product Line', NULL, 'draft'),
  ('33333333-3333-4333-8333-333333333333', 'header', 0, 'Age Group', 'Kelompok Umur', 'selesai'),
  ('33333333-3333-4333-8333-333333333333', 'column', 1, 'Completed Secondary Education', NULL, 'draft');

INSERT INTO public.qa_pairs (table_id, position, question_en, answer_en, question_id, answer_id, status) VALUES
  ('11111111-1111-4111-8111-111111111111', 0, 'Which country has the highest population density in Southeast Asia?', 'Singapore, with 8,019 people per square kilometre.', 'Negara mana yang memiliki kepadatan penduduk tertinggi di Asia Tenggara?', 'Singapura, dengan 8.019 jiwa per kilometer persegi.', 'selesai'),
  ('11111111-1111-4111-8111-111111111111', 1, 'What is the population density of Indonesia?', '145 people per square kilometre.', NULL, NULL, 'draft'),
  ('22222222-2222-4222-8222-222222222222', 0, 'Which region contributed the most revenue?', 'The Southeast region, at 42%.', NULL, NULL, 'draft'),
  ('33333333-3333-4333-8333-333333333333', 0, 'Which age group has the highest secondary completion rate?', 'The 25-34 age group, at 78%.', NULL, NULL, 'draft');