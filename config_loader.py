"""
配置文件加载器
- 优先读取 config.ini 中的 [keys] 节（简单字符串值）
- 若不存在或值为 xxx，则回退到环境变量
"""
import configparser
import os

CONFIG_FILE = "config.ini"

def get_key(key_name):
    """获取指定 key 的值，优先本地配置文件，其次环境变量"""
    config = configparser.ConfigParser()
    if os.path.exists(CONFIG_FILE):
        config.read(CONFIG_FILE)
        if config.has_section('keys') and config.has_option('keys', key_name):
            val = config.get('keys', key_name).strip()
            if val and val != "xxx":
                return val
    # 2. 回退到环境变量
    return os.environ.get(key_name, None)