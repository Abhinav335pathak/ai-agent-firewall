-- Seed data for the demo "company". Used on first boot and by POST /admin/reset.
-- Single source of truth: there is no separate init.sql to keep in sync.

DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS cloud_resources;
DROP TABLE IF EXISTS iam_roles;

CREATE TABLE customers (
    id    SERIAL PRIMARY KEY,
    name  VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL,
    plan  VARCHAR(50)  NOT NULL
);

INSERT INTO customers (name, email, plan) VALUES
    ('Alice Sharma', 'alice@acme.io', 'Enterprise'),
    ('Rohan Verma',  'rohan@acme.io', 'Pro'),
    ('Priya Nair',   'priya@acme.io', 'Enterprise');

CREATE TABLE cloud_resources (
    id            SERIAL PRIMARY KEY,
    resource_name VARCHAR(100) NOT NULL,
    status        VARCHAR(50)  NOT NULL
);

INSERT INTO cloud_resources (resource_name, status) VALUES
    ('prod-web-server-01', 'RUNNING');

CREATE TABLE iam_roles (
    username VARCHAR(100) PRIMARY KEY,
    role     VARCHAR(50)  NOT NULL
);

INSERT INTO iam_roles (username, role) VALUES
    ('ai-agent', 'VIEWER'),
    ('alice',    'ADMIN');
