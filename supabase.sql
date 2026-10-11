create table if not exists messages (
  id bigint generated always as identity primary key,
  chat_id bigint not null,
  role text not null check (role in ('user', 'model')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_chat_id_idx on messages (chat_id, id desc);

-- группы поставщиков
create table if not exists suppliers (
  chat_id bigint primary key,
  name text not null,
  lang text not null default 'ru' check (lang in ('ru', 'uz')),
  created_at timestamptz not null default now()
);

-- сообщения из групп поставщиков (чтобы Джарвис мог их прочитать по просьбе владельца)
create table if not exists group_messages (
  id bigint generated always as identity primary key,
  chat_id bigint not null,
  from_name text,
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists group_messages_chat_idx on group_messages (chat_id, id desc);

-- заказы поставщикам (уходят только после подтверждения кнопкой)
create table if not exists orders (
  id bigint generated always as identity primary key,
  supplier_chat_id bigint not null,
  supplier_name text not null,
  text text not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'cancelled', 'failed')),
  created_at timestamptz not null default now()
);

-- защита от повторной обработки одного и того же обновления Telegram
create table if not exists processed_updates (
  update_id bigint primary key,
  created_at timestamptz not null default now()
);

-- Доступ только с сервера через service key, поэтому RLS включён без политик
alter table messages enable row level security;
alter table suppliers enable row level security;
alter table group_messages enable row level security;
alter table orders enable row level security;
alter table processed_updates enable row level security;

-- ===== Обновление v3: автоответы поставщикам =====
-- режим автоответа на поставщика: off (молчит), ask (предлагает ответ, ты подтверждаешь), auto (отвечает сам)
alter table suppliers add column if not exists autoreply text not null default 'ask';
alter table suppliers drop constraint if exists suppliers_autoreply_check;
alter table suppliers add constraint suppliers_autoreply_check check (autoreply in ('off', 'ask', 'auto'));

-- чьи сообщения: владельца (образцы стиля) или нет
alter table group_messages add column if not exists is_owner boolean not null default false;

-- черновики ответов поставщикам используют ту же таблицу, что и заказы
alter table orders add column if not exists kind text not null default 'order';
alter table orders add column if not exists reply_to bigint;
alter table orders add column if not exists as_voice boolean not null default false;

-- лимит автоответов (защита от зацикливания и спама)
create table if not exists reply_log (
  id bigint generated always as identity primary key,
  chat_id bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists reply_log_chat_idx on reply_log (chat_id, created_at desc);
alter table reply_log enable row level security;

-- настройки (например, описание твоего стиля общения)
create table if not exists settings (
  key text primary key,
  value text not null
);
alter table settings enable row level security;
