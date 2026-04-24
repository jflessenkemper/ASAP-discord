-- 000_baseline.sql — squashed baseline migration.
--
-- Consolidates legacy migrations 001–020 (including 020's drop of the
-- original consumer-app schema) into a single idempotent baseline that
-- matches the prod DB snapshot as of April 2026.
--
-- How it works:
--   * On fresh DBs: this file runs first and creates all core tables.
--   * On existing DBs (applied_migrations already has 001–020 rows): the
--     migration runner marks this baseline as applied without executing,
--     because every CREATE is IF NOT EXISTS anyway.
--
-- Migrations 021+ continue to live as their own files.

--
-- PostgreSQL database dump
--

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.agent_activity_log (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    agent_id text NOT NULL,
    event text NOT NULL,
    detail text,
    duration_ms integer,
    tokens_in integer,
    tokens_out integer
);

--
-- Name: agent_activity_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.agent_activity_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: agent_activity_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_activity_log_id_seq OWNED BY public.agent_activity_log.id;

--
-- Name: agent_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.agent_embeddings (
    id bigint NOT NULL,
    agent_id text NOT NULL,
    content text NOT NULL,
    content_hash text NOT NULL,
    embedding public.vector(768),
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: agent_embeddings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.agent_embeddings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: agent_embeddings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_embeddings_id_seq OWNED BY public.agent_embeddings.id;

--
-- Name: agent_learnings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.agent_learnings (
    id bigint NOT NULL,
    agent_id text NOT NULL,
    tag text NOT NULL,
    pattern text NOT NULL,
    source text NOT NULL,
    confidence real DEFAULT 0.7,
    active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval)
);

--
-- Name: agent_learnings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.agent_learnings_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: agent_learnings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_learnings_id_seq OWNED BY public.agent_learnings.id;

--
-- Name: agent_memory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.agent_memory (
    file_name text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.decisions (
    id bigint NOT NULL,
    message_id text NOT NULL,
    channel_id text NOT NULL,
    groupchat_id text,
    options jsonb DEFAULT '[]'::jsonb NOT NULL,
    default_idx integer,
    reversible boolean DEFAULT true NOT NULL,
    context text,
    resolved_at timestamp with time zone,
    resolved_by text,
    resolution text,
    resolution_idx integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: decisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.decisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: decisions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.decisions_id_seq OWNED BY public.decisions.id;

--
-- Name: discord_message_dedupe; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.discord_message_dedupe (
    message_id text NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: job_listings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.job_listings (
    id integer NOT NULL,
    source text NOT NULL,
    external_id text,
    title text NOT NULL,
    company text NOT NULL,
    location text,
    salary_min integer,
    salary_max integer,
    url text NOT NULL,
    description text,
    score numeric(2,1),
    evaluation text,
    status text DEFAULT 'scanned'::text,
    discord_msg_id text,
    scanned_at timestamp with time zone DEFAULT now(),
    evaluated_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now(),
    cover_letter text,
    resume_text text
);

--
-- Name: job_listings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.job_listings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: job_listings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.job_listings_id_seq OWNED BY public.job_listings.id;

--
-- Name: job_portals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.job_portals (
    id integer NOT NULL,
    company_name text NOT NULL,
    careers_url text NOT NULL,
    api_type text,
    api_url text,
    enabled boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    board_api_key text
);

--
-- Name: job_portals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.job_portals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: job_portals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.job_portals_id_seq OWNED BY public.job_portals.id;

--
-- Name: job_profile; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.job_profile (
    id integer NOT NULL,
    user_id text DEFAULT 'owner'::text NOT NULL,
    cv_text text,
    target_roles text[] DEFAULT '{}'::text[],
    keywords_pos text[] DEFAULT '{}'::text[],
    keywords_neg text[] DEFAULT '{}'::text[],
    salary_min integer,
    salary_max integer,
    location text DEFAULT 'New South Wales'::text,
    remote_ok boolean DEFAULT true,
    deal_breakers text,
    preferences text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    first_name text,
    last_name text,
    email text,
    phone text
);

--
-- Name: job_profile_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.job_profile_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: job_profile_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.job_profile_id_seq OWNED BY public.job_profile.id;

--
-- Name: job_scan_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.job_scan_history (
    id integer NOT NULL,
    url text NOT NULL,
    source text NOT NULL,
    company text,
    title text,
    first_seen timestamp with time zone DEFAULT now()
);

--
-- Name: job_scan_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.job_scan_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: job_scan_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.job_scan_history_id_seq OWNED BY public.job_scan_history.id;

--
-- Name: model_health_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.model_health_log (
    id bigint NOT NULL,
    model_name text NOT NULL,
    status text NOT NULL,
    latency_ms integer,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: model_health_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.model_health_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: model_health_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.model_health_log_id_seq OWNED BY public.model_health_log.id;

--
-- Name: self_improvement_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.self_improvement_jobs (
    id bigint NOT NULL,
    job_type text DEFAULT 'self-improvement'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    payload jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 5 NOT NULL,
    run_after timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    claimed_by text,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);

--
-- Name: self_improvement_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.self_improvement_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: self_improvement_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.self_improvement_jobs_id_seq OWNED BY public.self_improvement_jobs.id;

--
-- Name: trace_spans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.trace_spans (
    id bigint NOT NULL,
    trace_id text NOT NULL,
    span_id text NOT NULL,
    parent_span_id text,
    agent_id text NOT NULL,
    model_name text,
    operation text NOT NULL,
    status text DEFAULT 'ok'::text NOT NULL,
    input_tokens integer DEFAULT 0,
    output_tokens integer DEFAULT 0,
    cache_read_tokens integer DEFAULT 0,
    cache_write_tokens integer DEFAULT 0,
    duration_ms integer,
    tool_name text,
    error_message text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: trace_spans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.trace_spans_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: trace_spans_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trace_spans_id_seq OWNED BY public.trace_spans.id;

--
-- Name: user_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.user_events (
    id bigint NOT NULL,
    user_id text NOT NULL,
    channel_id text NOT NULL,
    thread_id text,
    message_id text,
    kind text NOT NULL,
    text text,
    attachment_ref text,
    metadata jsonb DEFAULT '{}'::jsonb,
    embedding public.vector(768),
    embedded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: user_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS public.user_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: user_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_events_id_seq OWNED BY public.user_events.id;

--
-- Name: agent_activity_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_activity_log ALTER COLUMN id SET DEFAULT nextval('public.agent_activity_log_id_seq'::regclass);

--
-- Name: agent_embeddings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_embeddings ALTER COLUMN id SET DEFAULT nextval('public.agent_embeddings_id_seq'::regclass);

--
-- Name: agent_learnings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_learnings ALTER COLUMN id SET DEFAULT nextval('public.agent_learnings_id_seq'::regclass);

--
-- Name: decisions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decisions ALTER COLUMN id SET DEFAULT nextval('public.decisions_id_seq'::regclass);

--
-- Name: job_listings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_listings ALTER COLUMN id SET DEFAULT nextval('public.job_listings_id_seq'::regclass);

--
-- Name: job_portals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_portals ALTER COLUMN id SET DEFAULT nextval('public.job_portals_id_seq'::regclass);

--
-- Name: job_profile id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_profile ALTER COLUMN id SET DEFAULT nextval('public.job_profile_id_seq'::regclass);

--
-- Name: job_scan_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_scan_history ALTER COLUMN id SET DEFAULT nextval('public.job_scan_history_id_seq'::regclass);

--
-- Name: model_health_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_health_log ALTER COLUMN id SET DEFAULT nextval('public.model_health_log_id_seq'::regclass);

--
-- Name: self_improvement_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_improvement_jobs ALTER COLUMN id SET DEFAULT nextval('public.self_improvement_jobs_id_seq'::regclass);

--
-- Name: trace_spans id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trace_spans ALTER COLUMN id SET DEFAULT nextval('public.trace_spans_id_seq'::regclass);

--
-- Name: user_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_events ALTER COLUMN id SET DEFAULT nextval('public.user_events_id_seq'::regclass);

--
-- Name: agent_activity_log agent_activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_activity_log
    ADD CONSTRAINT agent_activity_log_pkey PRIMARY KEY (id);

--
-- Name: agent_embeddings agent_embeddings_agent_id_content_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_embeddings
    ADD CONSTRAINT agent_embeddings_agent_id_content_hash_key UNIQUE (agent_id, content_hash);

--
-- Name: agent_embeddings agent_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_embeddings
    ADD CONSTRAINT agent_embeddings_pkey PRIMARY KEY (id);

--
-- Name: agent_learnings agent_learnings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_learnings
    ADD CONSTRAINT agent_learnings_pkey PRIMARY KEY (id);

--
-- Name: agent_memory agent_memory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_memory
    ADD CONSTRAINT agent_memory_pkey PRIMARY KEY (file_name);

--
-- Name: decisions decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decisions
    ADD CONSTRAINT decisions_pkey PRIMARY KEY (id);

--
-- Name: discord_message_dedupe discord_message_dedupe_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discord_message_dedupe
    ADD CONSTRAINT discord_message_dedupe_pkey PRIMARY KEY (message_id);

--
-- Name: job_listings job_listings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_listings
    ADD CONSTRAINT job_listings_pkey PRIMARY KEY (id);

--
-- Name: job_listings job_listings_url_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_listings
    ADD CONSTRAINT job_listings_url_key UNIQUE (url);

--
-- Name: job_portals job_portals_company_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_portals
    ADD CONSTRAINT job_portals_company_name_key UNIQUE (company_name);

--
-- Name: job_portals job_portals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_portals
    ADD CONSTRAINT job_portals_pkey PRIMARY KEY (id);

--
-- Name: job_profile job_profile_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_profile
    ADD CONSTRAINT job_profile_pkey PRIMARY KEY (id);

--
-- Name: job_profile job_profile_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_profile
    ADD CONSTRAINT job_profile_user_id_key UNIQUE (user_id);

--
-- Name: job_scan_history job_scan_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_scan_history
    ADD CONSTRAINT job_scan_history_pkey PRIMARY KEY (id);

--
-- Name: job_scan_history job_scan_history_url_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_scan_history
    ADD CONSTRAINT job_scan_history_url_key UNIQUE (url);

--
-- Name: model_health_log model_health_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_health_log
    ADD CONSTRAINT model_health_log_pkey PRIMARY KEY (id);

--
-- Name: self_improvement_jobs self_improvement_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_improvement_jobs
    ADD CONSTRAINT self_improvement_jobs_pkey PRIMARY KEY (id);

--
-- Name: trace_spans trace_spans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trace_spans
    ADD CONSTRAINT trace_spans_pkey PRIMARY KEY (id);

--
-- Name: user_events user_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_events
    ADD CONSTRAINT user_events_pkey PRIMARY KEY (id);

--
-- Name: idx_agent_embeddings_agent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_agent_embeddings_agent_id ON public.agent_embeddings USING btree (agent_id);

--
-- Name: idx_agent_embeddings_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_agent_embeddings_created_at ON public.agent_embeddings USING btree (created_at);

--
-- Name: idx_agent_embeddings_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_agent_embeddings_hnsw ON public.agent_embeddings USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');

--
-- Name: idx_agent_learnings_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_agent_learnings_expires ON public.agent_learnings USING btree (expires_at) WHERE active;

--
-- Name: idx_agent_learnings_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_agent_learnings_lookup ON public.agent_learnings USING btree (agent_id, active, tag);

--
-- Name: idx_agent_log_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_agent_log_agent ON public.agent_activity_log USING btree (agent_id, ts DESC);

--
-- Name: idx_agent_log_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_agent_log_ts ON public.agent_activity_log USING btree (ts DESC);

--
-- Name: idx_agent_memory_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_agent_memory_updated ON public.agent_memory USING btree (updated_at);

--
-- Name: idx_decisions_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_decisions_message ON public.decisions USING btree (message_id);

--
-- Name: idx_decisions_unresolved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_decisions_unresolved ON public.decisions USING btree (created_at DESC) WHERE (resolved_at IS NULL);

--
-- Name: idx_job_listings_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_job_listings_score ON public.job_listings USING btree (score DESC NULLS LAST);

--
-- Name: idx_job_listings_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_job_listings_status ON public.job_listings USING btree (status);

--
-- Name: idx_job_scan_history_url; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_job_scan_history_url ON public.job_scan_history USING btree (url);

--
-- Name: idx_model_health_log_model; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_model_health_log_model ON public.model_health_log USING btree (model_name, created_at);

--
-- Name: idx_self_improvement_jobs_claimed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_self_improvement_jobs_claimed ON public.self_improvement_jobs USING btree (claimed_at) WHERE (status = 'processing'::text);

--
-- Name: idx_self_improvement_jobs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_self_improvement_jobs_created_at ON public.self_improvement_jobs USING btree (created_at);

--
-- Name: idx_self_improvement_jobs_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_self_improvement_jobs_pending ON public.self_improvement_jobs USING btree (status, run_after, id);

--
-- Name: idx_trace_spans_agent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_trace_spans_agent_id ON public.trace_spans USING btree (agent_id);

--
-- Name: idx_trace_spans_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_trace_spans_created_at ON public.trace_spans USING btree (created_at);

--
-- Name: idx_trace_spans_operation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_trace_spans_operation ON public.trace_spans USING btree (operation);

--
-- Name: idx_trace_spans_trace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_trace_spans_trace_id ON public.trace_spans USING btree (trace_id);

--
-- Name: idx_user_events_channel_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_user_events_channel_time ON public.user_events USING btree (channel_id, created_at DESC);

--
-- Name: idx_user_events_hnsw; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_user_events_hnsw ON public.user_events USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');

--
-- Name: idx_user_events_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_user_events_kind ON public.user_events USING btree (kind, created_at DESC);

--
-- Name: idx_user_events_pending_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_user_events_pending_embedding ON public.user_events USING btree (id) WHERE ((embedding IS NULL) AND (text IS NOT NULL));

--
-- Name: idx_user_events_thread_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_user_events_thread_time ON public.user_events USING btree (thread_id, created_at DESC) WHERE (thread_id IS NOT NULL);

--
-- Name: idx_user_events_user_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_user_events_user_time ON public.user_events USING btree (user_id, created_at DESC);

--
-- PostgreSQL database dump complete
--

