-- Migration: Seed System Profiles and Property Definitions
-- Description: Creates initial system profiles (note, task, project, event, person, company) and their property definitions.
-- This migration is idempotent - safe to run multiple times.
-- Date: 2025-02-XX

DO $$
DECLARE
    -- Property definition IDs (will be populated)
    prop_title_id uuid;
    prop_status_id uuid;
    prop_priority_id uuid;
    prop_dueDate_id uuid;
    prop_startTime_id uuid;
    prop_endTime_id uuid;
    prop_assignee_id uuid;
    prop_tags_id uuid;
    prop_description_id uuid;
    prop_website_id uuid;
    prop_industry_id uuid;
    prop_employees_id uuid;
    prop_location_id uuid;
    prop_email_id uuid;
    prop_phone_id uuid;
    
    -- Profile IDs (will be populated)
    profile_note_id uuid;
    profile_task_id uuid;
    profile_project_id uuid;
    profile_event_id uuid;
    profile_person_id uuid;
    profile_company_id uuid;
BEGIN
    -- ============================================================================
    -- 1. CREATE PROPERTY DEFINITIONS
    -- ============================================================================
    
    -- Title (reusable)
    INSERT INTO property_defs (slug, value_type, constraints, ui_hints)
    VALUES (
        'title',
        'string',
        '{"minLength": 1, "maxLength": 500}'::jsonb,
        '{"label": "Title", "inputType": "text", "required": true}'::jsonb
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO prop_title_id;
    
    SELECT id INTO prop_title_id FROM property_defs WHERE slug = 'title';
    
    -- Status
    INSERT INTO property_defs (slug, value_type, constraints, ui_hints)
    VALUES (
        'status',
        'string',
        '{"enum": ["todo", "in-progress", "done", "cancelled"]}'::jsonb,
        '{"label": "Status", "inputType": "select"}'::jsonb
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO prop_status_id;
    
    SELECT id INTO prop_status_id FROM property_defs WHERE slug = 'status';
    
    -- Priority
    INSERT INTO property_defs (slug, value_type, constraints, ui_hints)
    VALUES (
        'priority',
        'string',
        '{"enum": ["low", "medium", "high", "urgent"]}'::jsonb,
        '{"label": "Priority", "inputType": "select"}'::jsonb
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO prop_priority_id;
    
    SELECT id INTO prop_priority_id FROM property_defs WHERE slug = 'priority';
    
    -- Due Date
    INSERT INTO property_defs (slug, value_type, constraints, ui_hints)
    VALUES (
        'dueDate',
        'date',
        '{}'::jsonb,
        '{"label": "Due Date", "inputType": "date"}'::jsonb
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO prop_dueDate_id;
    
    SELECT id INTO prop_dueDate_id FROM property_defs WHERE slug = 'dueDate';
    
    -- Start Time
    INSERT INTO property_defs (slug, value_type, constraints, ui_hints)
    VALUES (
        'startTime',
        'date',
        '{}'::jsonb,
        '{"label": "Start Time", "inputType": "datetime-local"}'::jsonb
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO prop_startTime_id;
    
    SELECT id INTO prop_startTime_id FROM property_defs WHERE slug = 'startTime';
    
    -- End Time
    INSERT INTO property_defs (slug, value_type, constraints, ui_hints)
    VALUES (
        'endTime',
        'date',
        '{}'::jsonb,
        '{"label": "End Time", "inputType": "datetime-local"}'::jsonb
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO prop_endTime_id;
    
    SELECT id INTO prop_endTime_id FROM property_defs WHERE slug = 'endTime';
    
    -- Assignee
    INSERT INTO property_defs (slug, value_type, constraints, ui_hints)
    VALUES (
        'assignee',
        'entity_id',
        '{}'::jsonb,
        '{"label": "Assignee", "inputType": "entity-select"}'::jsonb
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO prop_assignee_id;
    
    SELECT id INTO prop_assignee_id FROM property_defs WHERE slug = 'assignee';
    
    -- Tags
    INSERT INTO property_defs (slug, value_type, constraints, ui_hints)
    VALUES (
        'tags',
        'array',
        '{}'::jsonb,
        '{"label": "Tags", "inputType": "tags"}'::jsonb
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO prop_tags_id;
    
    SELECT id INTO prop_tags_id FROM property_defs WHERE slug = 'tags';
    
    -- Description
    INSERT INTO property_defs (slug, value_type, constraints, ui_hints)
    VALUES (
        'description',
        'string',
        '{"maxLength": 5000}'::jsonb,
        '{"label": "Description", "inputType": "textarea"}'::jsonb
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO prop_description_id;
    
    SELECT id INTO prop_description_id FROM property_defs WHERE slug = 'description';
    
    -- Website
    INSERT INTO property_defs (slug, value_type, constraints, ui_hints)
    VALUES (
        'website',
        'string',
        '{}'::jsonb,
        '{"label": "Website", "inputType": "url"}'::jsonb
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO prop_website_id;
    
    SELECT id INTO prop_website_id FROM property_defs WHERE slug = 'website';
    
    -- Industry
    INSERT INTO property_defs (slug, value_type, constraints, ui_hints)
    VALUES (
        'industry',
        'string',
        '{}'::jsonb,
        '{"label": "Industry", "inputType": "text"}'::jsonb
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO prop_industry_id;
    
    SELECT id INTO prop_industry_id FROM property_defs WHERE slug = 'industry';
    
    -- Employees
    INSERT INTO property_defs (slug, value_type, constraints, ui_hints)
    VALUES (
        'employees',
        'number',
        '{"min": 0}'::jsonb,
        '{"label": "Employees", "inputType": "number"}'::jsonb
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO prop_employees_id;
    
    SELECT id INTO prop_employees_id FROM property_defs WHERE slug = 'employees';
    
    -- Location
    INSERT INTO property_defs (slug, value_type, constraints, ui_hints)
    VALUES (
        'location',
        'string',
        '{}'::jsonb,
        '{"label": "Location", "inputType": "text"}'::jsonb
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO prop_location_id;
    
    SELECT id INTO prop_location_id FROM property_defs WHERE slug = 'location';
    
    -- Email
    INSERT INTO property_defs (slug, value_type, constraints, ui_hints)
    VALUES (
        'email',
        'string',
        '{}'::jsonb,
        '{"label": "Email", "inputType": "email"}'::jsonb
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO prop_email_id;
    
    SELECT id INTO prop_email_id FROM property_defs WHERE slug = 'email';
    
    -- Phone
    INSERT INTO property_defs (slug, value_type, constraints, ui_hints)
    VALUES (
        'phone',
        'string',
        '{}'::jsonb,
        '{"label": "Phone", "inputType": "phone"}'::jsonb
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO prop_phone_id;
    
    SELECT id INTO prop_phone_id FROM property_defs WHERE slug = 'phone';
    
    -- ============================================================================
    -- 2. CREATE SYSTEM PROFILES
    -- ============================================================================
    
    -- Note
    INSERT INTO profiles (slug, display_name, ui_hints, scope, is_active, version)
    VALUES (
        'note',
        'Note',
        '{"icon": "file-text", "color": "#6B7280"}'::jsonb,
        'system',
        true,
        1
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO profile_note_id;
    
    SELECT id INTO profile_note_id FROM profiles WHERE slug = 'note' AND scope = 'system';
    
    -- Task
    INSERT INTO profiles (slug, display_name, ui_hints, scope, is_active, version)
    VALUES (
        'task',
        'Task',
        '{"icon": "check-square", "color": "#3B82F6"}'::jsonb,
        'system',
        true,
        1
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO profile_task_id;
    
    SELECT id INTO profile_task_id FROM profiles WHERE slug = 'task' AND scope = 'system';
    
    -- Project
    INSERT INTO profiles (slug, display_name, ui_hints, scope, is_active, version)
    VALUES (
        'project',
        'Project',
        '{"icon": "folder", "color": "#8B5CF6"}'::jsonb,
        'system',
        true,
        1
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO profile_project_id;
    
    SELECT id INTO profile_project_id FROM profiles WHERE slug = 'project' AND scope = 'system';
    
    -- Event
    INSERT INTO profiles (slug, display_name, ui_hints, scope, is_active, version)
    VALUES (
        'event',
        'Event',
        '{"icon": "calendar", "color": "#10B981"}'::jsonb,
        'system',
        true,
        1
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO profile_event_id;
    
    SELECT id INTO profile_event_id FROM profiles WHERE slug = 'event' AND scope = 'system';
    
    -- Person
    INSERT INTO profiles (slug, display_name, ui_hints, scope, is_active, version)
    VALUES (
        'person',
        'Person',
        '{"icon": "user", "color": "#F59E0B"}'::jsonb,
        'system',
        true,
        1
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO profile_person_id;
    
    SELECT id INTO profile_person_id FROM profiles WHERE slug = 'person' AND scope = 'system';
    
    -- Company (NEW)
    INSERT INTO profiles (slug, display_name, ui_hints, scope, is_active, version)
    VALUES (
        'company',
        'Company',
        '{"icon": "building", "color": "#6366F1"}'::jsonb,
        'system',
        true,
        1
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO profile_company_id;
    
    SELECT id INTO profile_company_id FROM profiles WHERE slug = 'company' AND scope = 'system';
    
    -- ============================================================================
    -- 3. LINK PROPERTIES TO PROFILES
    -- ============================================================================
    
    -- Task properties
    INSERT INTO profile_properties (profile_id, property_def_id, required, default_value, display_order)
    VALUES
        (profile_task_id, prop_title_id, true, NULL, 0),
        (profile_task_id, prop_status_id, false, '"todo"'::jsonb, 1),
        (profile_task_id, prop_priority_id, false, NULL, 2),
        (profile_task_id, prop_dueDate_id, false, NULL, 3),
        (profile_task_id, prop_assignee_id, false, NULL, 4),
        (profile_task_id, prop_tags_id, false, NULL, 5),
        (profile_task_id, prop_description_id, false, NULL, 6)
    ON CONFLICT (profile_id, property_def_id) DO NOTHING;
    
    -- Event properties
    INSERT INTO profile_properties (profile_id, property_def_id, required, default_value, display_order)
    VALUES
        (profile_event_id, prop_title_id, true, NULL, 0),
        (profile_event_id, prop_startTime_id, false, NULL, 1),
        (profile_event_id, prop_endTime_id, false, NULL, 2),
        (profile_event_id, prop_tags_id, false, NULL, 3),
        (profile_event_id, prop_description_id, false, NULL, 4)
    ON CONFLICT (profile_id, property_def_id) DO NOTHING;
    
    -- Note properties
    INSERT INTO profile_properties (profile_id, property_def_id, required, default_value, display_order)
    VALUES
        (profile_note_id, prop_title_id, false, NULL, 0),
        (profile_note_id, prop_tags_id, false, NULL, 1),
        (profile_note_id, prop_description_id, false, NULL, 2)
    ON CONFLICT (profile_id, property_def_id) DO NOTHING;
    
    -- Project properties
    INSERT INTO profile_properties (profile_id, property_def_id, required, default_value, display_order)
    VALUES
        (profile_project_id, prop_title_id, true, NULL, 0),
        (profile_project_id, prop_status_id, false, '"active"'::jsonb, 1),
        (profile_project_id, prop_tags_id, false, NULL, 2),
        (profile_project_id, prop_description_id, false, NULL, 3)
    ON CONFLICT (profile_id, property_def_id) DO NOTHING;
    
    -- Person properties
    INSERT INTO profile_properties (profile_id, property_def_id, required, default_value, display_order)
    VALUES
        (profile_person_id, prop_title_id, true, NULL, 0),
        (profile_person_id, prop_email_id, false, NULL, 1),
        (profile_person_id, prop_phone_id, false, NULL, 2),
        (profile_person_id, prop_tags_id, false, NULL, 3),
        (profile_person_id, prop_description_id, false, NULL, 4)
    ON CONFLICT (profile_id, property_def_id) DO NOTHING;
    
    -- Company properties (NEW)
    INSERT INTO profile_properties (profile_id, property_def_id, required, default_value, display_order)
    VALUES
        (profile_company_id, prop_title_id, true, NULL, 0),
        (profile_company_id, prop_website_id, false, NULL, 1),
        (profile_company_id, prop_industry_id, false, NULL, 2),
        (profile_company_id, prop_employees_id, false, NULL, 3),
        (profile_company_id, prop_location_id, false, NULL, 4),
        (profile_company_id, prop_tags_id, false, NULL, 5),
        (profile_company_id, prop_description_id, false, NULL, 6)
    ON CONFLICT (profile_id, property_def_id) DO NOTHING;
    
    RAISE NOTICE 'System profiles and property definitions seeded successfully';
END $$;
