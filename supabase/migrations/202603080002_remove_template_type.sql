alter table if exists prompt_files
  drop column if exists template_type;

drop type if exists template_type;
