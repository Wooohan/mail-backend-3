import logging
from typing import Optional, Dict, Any, List

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from models.login_history import Login_history

logger = logging.getLogger(__name__)


# ------------------ Service Layer ------------------
class Login_historyService:
    """Service layer for Login_history operations"""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def create(self, data: Dict[str, Any], user_id: Optional[str] = None) -> Optional[Login_history]:
        """Create a new login_history"""
        try:
            if user_id:
                data['user_id'] = user_id
            obj = Login_history(**data)
            self.db.add(obj)
            await self.db.commit()
            await self.db.refresh(obj)
            logger.info(f"Created login_history with id: {obj.id}")
            return obj
        except Exception as e:
            await self.db.rollback()
            logger.error(f"Error creating login_history: {str(e)}")
            raise

    async def check_ownership(self, obj_id: int, user_id: str) -> bool:
        """Check if user owns this record"""
        try:
            obj = await self.get_by_id(obj_id, user_id=user_id)
            return obj is not None
        except Exception as e:
            logger.error(f"Error checking ownership for login_history {obj_id}: {str(e)}")
            return False

    async def get_by_id(self, obj_id: int, user_id: Optional[str] = None) -> Optional[Login_history]:
        """Get login_history by ID (user can only see their own records)"""
        try:
            query = select(Login_history).where(Login_history.id == obj_id)
            if user_id:
                query = query.where(Login_history.user_id == user_id)
            result = await self.db.execute(query)
            return result.scalar_one_or_none()
        except Exception as e:
            logger.error(f"Error fetching login_history {obj_id}: {str(e)}")
            raise

    async def get_list(
        self, 
        skip: int = 0, 
        limit: int = 20, 
        user_id: Optional[str] = None,
        query_dict: Optional[Dict[str, Any]] = None,
        sort: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Get paginated list of login_historys (user can only see their own records)"""
        try:
            query = select(Login_history)
            count_query = select(func.count(Login_history.id))
            
            if user_id:
                query = query.where(Login_history.user_id == user_id)
                count_query = count_query.where(Login_history.user_id == user_id)
            
            if query_dict:
                for field, value in query_dict.items():
                    if hasattr(Login_history, field):
                        query = query.where(getattr(Login_history, field) == value)
                        count_query = count_query.where(getattr(Login_history, field) == value)
            
            count_result = await self.db.execute(count_query)
            total = count_result.scalar()

            if sort:
                if sort.startswith('-'):
                    field_name = sort[1:]
                    if hasattr(Login_history, field_name):
                        query = query.order_by(getattr(Login_history, field_name).desc())
                else:
                    if hasattr(Login_history, sort):
                        query = query.order_by(getattr(Login_history, sort))
            else:
                query = query.order_by(Login_history.id.desc())

            result = await self.db.execute(query.offset(skip).limit(limit))
            items = result.scalars().all()

            return {
                "items": items,
                "total": total,
                "skip": skip,
                "limit": limit,
            }
        except Exception as e:
            logger.error(f"Error fetching login_history list: {str(e)}")
            raise

    async def update(self, obj_id: int, update_data: Dict[str, Any], user_id: Optional[str] = None) -> Optional[Login_history]:
        """Update login_history (requires ownership)"""
        try:
            obj = await self.get_by_id(obj_id, user_id=user_id)
            if not obj:
                logger.warning(f"Login_history {obj_id} not found for update")
                return None
            for key, value in update_data.items():
                if hasattr(obj, key) and key != 'user_id':
                    setattr(obj, key, value)

            await self.db.commit()
            await self.db.refresh(obj)
            logger.info(f"Updated login_history {obj_id}")
            return obj
        except Exception as e:
            await self.db.rollback()
            logger.error(f"Error updating login_history {obj_id}: {str(e)}")
            raise

    async def delete(self, obj_id: int, user_id: Optional[str] = None) -> bool:
        """Delete login_history (requires ownership)"""
        try:
            obj = await self.get_by_id(obj_id, user_id=user_id)
            if not obj:
                logger.warning(f"Login_history {obj_id} not found for deletion")
                return False
            await self.db.delete(obj)
            await self.db.commit()
            logger.info(f"Deleted login_history {obj_id}")
            return True
        except Exception as e:
            await self.db.rollback()
            logger.error(f"Error deleting login_history {obj_id}: {str(e)}")
            raise

    async def get_by_field(self, field_name: str, field_value: Any) -> Optional[Login_history]:
        """Get login_history by any field"""
        try:
            if not hasattr(Login_history, field_name):
                raise ValueError(f"Field {field_name} does not exist on Login_history")
            result = await self.db.execute(
                select(Login_history).where(getattr(Login_history, field_name) == field_value)
            )
            return result.scalar_one_or_none()
        except Exception as e:
            logger.error(f"Error fetching login_history by {field_name}: {str(e)}")
            raise

    async def list_by_field(
        self, field_name: str, field_value: Any, skip: int = 0, limit: int = 20
    ) -> List[Login_history]:
        """Get list of login_historys filtered by field"""
        try:
            if not hasattr(Login_history, field_name):
                raise ValueError(f"Field {field_name} does not exist on Login_history")
            result = await self.db.execute(
                select(Login_history)
                .where(getattr(Login_history, field_name) == field_value)
                .offset(skip)
                .limit(limit)
                .order_by(Login_history.id.desc())
            )
            return result.scalars().all()
        except Exception as e:
            logger.error(f"Error fetching login_historys by {field_name}: {str(e)}")
            raise
